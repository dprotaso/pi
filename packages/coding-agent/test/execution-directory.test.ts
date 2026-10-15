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

	it("keeps detached work in the directory where it started and updates the indicator", async () => {
		let updates = 0;
		const directory = new ExecutionDirectory(root, () => {
			updates++;
		});
		const release = gate();
		let detached: Promise<string> = Promise.resolve("");
		await directory.run("a", async () => {
			detached = release.promise.then(() => directory.cwd);
		});
		expect(directory.activeDirectories).toEqual([]);
		expect(updates).toBe(2);
		release.resolve();
		expect(await detached).toBe(join(root, "a"));
		expect(directory.cwd).toBe(root);
	});
});
