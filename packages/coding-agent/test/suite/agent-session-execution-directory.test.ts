import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("AgentSession execution directories", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("scopes built-in tools, hooks, prompt and extension exec without replacing the session", async () => {
		let api: ExtensionAPI | undefined;
		const hookDirectories: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("tool_call", (_event, ctx) => {
						hookDirectories.push(ctx.cwd);
					});
					pi.on("tool_result", (_event, ctx) => {
						hookDirectories.push(ctx.cwd);
					});
				},
			],
		});
		harnesses.push(harness);
		const { session, tempDir } = harness;
		const worktree = join(tempDir, "worktree");
		mkdirSync(worktree);
		writeFileSync(join(tempDir, "item.txt"), "base");
		writeFileSync(join(worktree, "item.txt"), "worktree");
		const header = session.sessionManager.getHeader();
		const sessionId = session.sessionId;
		const loader = session.resourceLoader;
		const statuses: Array<string | undefined> = [];
		await session.bindExtensions({
			uiContext: createTestUiContext({
				setStatus: (_key, text) => {
					statuses.push(text);
				},
			}),
		});
		harness.setResponses([
			(context) => {
				expect(getCurrentSystemPrompt(context.messages)).toContain(worktree);
				return fauxAssistantMessage(
					[fauxToolCall("read", { path: "item.txt" }), fauxToolCall("write", { path: "new.txt", content: "new" })],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "item.txt", edits: [{ oldText: "worktree", newText: "changed" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const ctx = session.extensionRunner.createCommandContext();
		await ctx.withExecutionDirectory("worktree", async () => {
			expect(ctx.cwd).toBe(worktree);
			expect(session.executionDirectory).toBe(worktree);
			expect(ctx.getSystemPrompt()).toContain(worktree);
			expect(ctx.getSystemPromptOptions().cwd).toBe(worktree);
			expect(realpathSync((await api?.exec(process.execPath, ["-p", "process.cwd()"]))?.stdout.trim() ?? "")).toBe(
				realpathSync(worktree),
			);
			expect(
				realpathSync(
					(await api?.exec(process.execPath, ["-p", "process.cwd()"], { cwd: tempDir }))?.stdout.trim() ?? "",
				),
			).toBe(realpathSync(tempDir));
			await session.prompt("read, write and edit");
		});
		expect(getMessageText(getToolResult(harness, "read"))).toContain("worktree");
		expect(getToolResult(harness, "edit").isError).toBeFalsy();
		expect(readFileSync(join(worktree, "item.txt"), "utf8")).toBe("changed");
		expect(readFileSync(join(tempDir, "item.txt"), "utf8")).toBe("base");
		expect(existsSync(join(tempDir, "new.txt"))).toBe(false);
		expect(readFileSync(join(worktree, "new.txt"), "utf8")).toBe("new");
		expect(hookDirectories).toEqual(Array(6).fill(worktree));
		expect(statuses).toEqual([undefined, `exec: ${JSON.stringify(worktree)}`, undefined]);
		expect(session.sessionId).toBe(sessionId);
		expect(session.sessionManager.getHeader()).toEqual(header);
		expect(session.resourceLoader).toBe(loader);
		expect(ctx.cwd).toBe(tempDir);
		expect(session.activeExecutionDirectories).toEqual([]);
		harness.setResponses([
			(context) => {
				expect(getCurrentSystemPrompt(context.messages)).not.toContain(worktree);
				return fauxAssistantMessage([fauxToolCall("read", { path: "item.txt" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await session.prompt("read from the original directory");
		expect(getMessageText(getToolResult(harness, "read"))).toContain("base");
	});

	it.each(["parallel", "sequential"] as const)("isolates nested tools and hooks with %s execution", async (mode) => {
		const seen: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event, ctx) => {
						if (event.parentToolCallId) seen.push(ctx.cwd);
					});
					pi.on("tool_result", (event, ctx) => {
						if (event.parentToolCallId) seen.push(ctx.cwd);
					});
					pi.registerTool({
						name: "review",
						label: "review",
						description: "review",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							const contents = await Promise.all(
								["a", "b"].map((name) =>
									ctx.withExecutionDirectory(name, async () => {
										const result = await ctx.executeTool("read", { path: "item.txt" });
										if (result.isError) throw new Error(getMessageText(result.result));
										return getMessageText(result.result);
									}),
								),
							);
							return { content: [{ type: "text", text: contents.join("|") }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		for (const name of ["a", "b"]) {
			mkdirSync(join(harness.tempDir, name));
			writeFileSync(join(harness.tempDir, name, "item.txt"), name);
		}
		harness.session.agent.toolExecution = mode;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("review", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review both");
		expect(getToolResult(harness, "review").isError).toBeFalsy();
		expect(getMessageText(getToolResult(harness, "review"))).toContain("a|b");
		expect(seen.sort()).toEqual(["a", "a", "b", "b"].map((name) => join(harness.tempDir, name)));
		expect(harness.session.activeExecutionDirectories).toEqual([]);
	});

	it("keeps extension-started turns alive after the callback returns", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("review", {
						handler: async (_args, ctx) => {
							await ctx.withExecutionDirectory("worktree", async () => {
								pi.sendUserMessage("review");
							});
						},
					});
				},
			],
		});
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, "worktree"));
		writeFileSync(join(harness.tempDir, "worktree", "item.txt"), "scoped");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "item.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("/review");
		expect(getMessageText(getToolResult(harness, "read"))).toBe("scoped");
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.activeExecutionDirectories).toEqual([]);
	});

	it("scopes direct bash execution and restores the indicator after abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const worktree = join(harness.tempDir, "worktree");
		mkdirSync(worktree);
		await harness.session.withExecutionDirectory(worktree, async () => {
			const result = await harness.session.executeBash("pwd");
			expect(realpathSync(result.output.trim())).toBe(realpathSync(worktree));
		});
		const entered = gate();
		harness.setResponses([fauxAssistantMessage("should not run")]);
		await harness.session.bindExtensions({});
		const run = harness.session.withExecutionDirectory(worktree, async () => {
			const command = harness.session.executeBash("sleep 30", () => {});
			entered.resolve();
			expect((await command).cancelled).toBe(true);
		});
		await entered.promise;
		harness.session.abortBash();
		await run;
		expect(harness.session.executionDirectory).toBe(harness.tempDir);
		expect(harness.session.activeExecutionDirectories).toEqual([]);
	});

	it("rejects scoped submissions after an input hook yields to another directory's run", async () => {
		const inputEntered = gate();
		const releaseInput = gate();
		const runEntered = gate();
		const releaseRun = gate();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "second") {
							inputEntered.resolve();
							await releaseInput.promise;
						}
					});
					pi.on("before_agent_start", async () => {
						runEntered.resolve();
						await releaseRun.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		for (const name of ["a", "b"]) mkdirSync(join(harness.tempDir, name));
		harness.setResponses([fauxAssistantMessage("done")]);
		const second = harness.session.withExecutionDirectory("b", async () => {
			await expect(harness.session.prompt("second", { streamingBehavior: "followUp" })).rejects.toThrow(
				"different execution directory",
			);
		});
		await inputEntered.promise;
		const first = harness.session.withExecutionDirectory("a", () => harness.session.prompt("first"));
		await runEntered.promise;
		releaseInput.resolve();
		await second;
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		releaseRun.resolve();
		await first;
	});

	it("rejects scoped work that would leave the scope inside another run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, "worktree"));
		await harness.session.withExecutionDirectory("worktree", async () => {
			await expect(harness.session.steer("later")).rejects.toThrow("without an active run");
			await expect(harness.session.followUp("later")).rejects.toThrow("without an active run");
			await expect(
				harness.session.sendCustomMessage(
					{ customType: "later", content: "later", display: true },
					{ deliverAs: "nextTurn" },
				),
			).rejects.toThrow("nextTurn");
		});
	});

	it("rejects reload and replacement commands while scoped, and stale contexts after disposal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const ctx = harness.session.extensionRunner.createCommandContext();
		await ctx.withExecutionDirectory(harness.tempDir, async () => {
			await expect(harness.session.reload()).rejects.toThrow("scopes are active");
			expect(() => ctx.newSession()).toThrow("scopes are active");
			expect(() => ctx.switchSession("other.jsonl")).toThrow("scopes are active");
			expect(() => ctx.fork("entry")).toThrow("scopes are active");
			expect(() => ctx.reload()).toThrow("scopes are active");
		});
		harness.session.dispose();
		expect(() => ctx.withExecutionDirectory(harness.tempDir, async () => {})).toThrow("stale");
	});
});
