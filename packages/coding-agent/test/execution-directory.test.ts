import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutionDirectory } from "../src/core/execution-directory.ts";

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("execution directory scopes", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-execution-directory-"));
		mkdirSync(join(root, "a", "nested"), { recursive: true });
		mkdirSync(join(root, "b"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("returns values and restores nested directories after exceptions without chdir", async () => {
		const directory = new ExecutionDirectory(root);
		const processCwd = process.cwd();
		const failure = new Error("failed");
		expect(
			await directory.run("a", async () => {
				expect(directory.cwd).toBe(join(root, "a"));
				await expect(
					directory.run("nested", async () => {
						expect(directory.cwd).toBe(join(root, "a", "nested"));
						throw failure;
					}),
				).rejects.toBe(failure);
				expect(directory.cwd).toBe(join(root, "a"));
				return 42;
			}),
		).toBe(42);
		expect(directory.cwd).toBe(root);
		expect(directory.activeDirectories).toEqual([]);
		expect(process.cwd()).toBe(processCwd);
	});

	it("isolates overlapping siblings and separate sessions, including out-of-order completion", async () => {
		const directory = new ExecutionDirectory(root);
		const other = new ExecutionDirectory(join(root, "b"));
		const a = gate();
		const b = gate();
		const first = directory.run("a", async () => {
			await a.promise;
			expect(directory.cwd).toBe(join(root, "a"));
			expect(other.cwd).toBe(join(root, "b"));
		});
		const second = directory.run("b", async () => {
			await b.promise;
			expect(directory.cwd).toBe(join(root, "b"));
		});
		expect(directory.cwd).toBe(root);
		expect(directory.activeDirectories).toEqual([join(root, "a"), join(root, "b")]);
		a.resolve();
		await first;
		expect(directory.activeDirectories).toEqual([join(root, "b")]);
		b.resolve();
		await second;
		expect(directory.activeDirectories).toEqual([]);
	});

	it("rejects missing paths and files before calling the callback", async () => {
		const directory = new ExecutionDirectory(root);
		writeFileSync(join(root, "file"), "file");
		let called = false;
		const callback = async () => {
			called = true;
		};
		await expect(directory.run("missing", callback)).rejects.toThrow();
		await expect(directory.run("file", callback)).rejects.toThrow("not a directory");
		expect(called).toBe(false);
		expect(directory.activeDirectories).toEqual([]);
	});

	it("rejects detached work after the callback ends instead of falling back to another directory", async () => {
		const directory = new ExecutionDirectory(root);
		const release = gate();
		let detached: Promise<void> = Promise.resolve();
		await directory.run("a", async () => {
			detached = release.promise.then(() => {
				expect(() => directory.cwd).toThrow("scope has ended");
			});
		});
		release.resolve();
		await detached;
		expect(directory.cwd).toBe(root);
	});

	it("drains tracked extension actions even when the callback throws", async () => {
		const directory = new ExecutionDirectory(root);
		const release = gate();
		let finished = false;
		const run = directory.run("a", async () => {
			directory.track(
				release.promise.then(() => {
					expect(directory.cwd).toBe(join(root, "a"));
					finished = true;
				}),
			);
			throw new Error("callback failed");
		});
		const rejected = expect(run).rejects.toThrow("callback failed");
		expect(directory.activeDirectories).toEqual([join(root, "a")]);
		release.resolve();
		await rejected;
		expect(finished).toBe(true);
		expect(directory.activeDirectories).toEqual([]);
	});

	it("blocks scope entry during transitions and transitions during scopes", async () => {
		const directory = new ExecutionDirectory(root);
		const resume = directory.suspend();
		await expect(directory.run("a", async () => {})).rejects.toThrow("replacement or reload");
		resume();
		await directory.run("a", async () => {
			expect(() => directory.suspend()).toThrow("scopes are active");
		});
	});

	it("invalidates scopes on disposal without late indicator updates", async () => {
		let updates = 0;
		const directory = new ExecutionDirectory(root, () => {
			updates++;
		});
		await directory.run("a", async () => {
			directory.dispose();
			expect(() => directory.cwd).toThrow("disposed session");
		});
		directory.dispose();
		expect(updates).toBe(2);
		expect(directory.activeDirectories).toEqual([]);
	});

	it("lets session-owned background work escape callback lifetime", async () => {
		const directory = new ExecutionDirectory(root);
		const release = gate();
		let background: Promise<void> = Promise.resolve();
		await directory.run("a", async () => {
			background = directory.outsideScope(() =>
				release.promise.then(() => {
					expect(directory.cwd).toBe(root);
				}),
			);
		});
		release.resolve();
		await background;
	});
});
