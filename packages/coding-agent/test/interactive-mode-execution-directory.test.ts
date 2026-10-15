import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ExecutionDirectory, ExecutionDirectoryBusyError } from "../src/core/execution-directory.ts";
import type { ToolRenderers } from "../src/core/extensions/types.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const handleFatalRuntimeError = Reflect.get(InteractiveMode.prototype, "handleFatalRuntimeError") as (
	this: unknown,
	prefix: string,
	error: unknown,
) => Promise<{ cancelled: true }>;

function createGuardTestContext(directory: ExecutionDirectory) {
	const replaceSession = vi.fn(async () => {
		const resume = directory.suspend();
		resume();
		return { cancelled: false };
	});
	const editor = new Text("draft", 0, 0);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const chatContainer = new Container();
	chatContainer.addChild(new Text("live transcript", 0, 0));
	return {
		editor,
		editorContainer,
		chatContainer,
		outputPad: 1,
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		runtimeHost: { newSession: replaceSession, switchSession: replaceSession, importFromJsonl: replaceSession },
		session: {
			isStreaming: false,
			isCompacting: false,
			suspendExecutionDirectories: () => directory.suspend(),
			reload: vi.fn(),
		},
		clearStatusIndicator: vi.fn(),
		resetExtensionUI: vi.fn(),
		stop: vi.fn(),
		recordCrash: vi.fn(),
		getCrashExtensionHint: vi.fn(),
		showError: InteractiveMode.prototype.showError,
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showExtensionConfirm: vi.fn(async () => true),
		getPathCommandArgument: () => "session.jsonl",
		handleFatalRuntimeError,
	};
}

describe("InteractiveMode execution directory guard rejection", () => {
	it.each(["handleClearCommand", "handleResumeSession", "handleImportCommand"])(
		"keeps the live UI intact and allows retry after %s is rejected",
		async (method) => {
			initTheme("dark");
			const directory = new ExecutionDirectory(process.cwd());
			const context = createGuardTestContext(directory);
			const transcript = context.chatContainer.children[0];
			const command = Reflect.get(InteractiveMode.prototype, method) as (
				this: typeof context,
				argument: string,
			) => Promise<unknown>;
			const exit = vi.spyOn(process, "exit").mockImplementation(() => {
				throw new Error("Unexpected process exit");
			});
			try {
				await directory.run(".", async () => {
					await command.call(context, "session.jsonl");
					expect(directory.activeDirectories).toEqual([process.cwd()]);
				});
				expect(context.chatContainer.children[0]).toBe(transcript);
				expect(context.chatContainer.render(200).join("\n")).toContain(
					"Cannot replace or reload the session while execution directory scopes are active",
				);
				expect(context.editorContainer.children).toEqual([context.editor]);
				expect(context.editor.render(80).join("\n")).toContain("draft");
				expect(context.clearStatusIndicator).not.toHaveBeenCalled();
				expect(context.resetExtensionUI).not.toHaveBeenCalled();
				expect(context.recordCrash).not.toHaveBeenCalled();
				expect(context.getCrashExtensionHint).not.toHaveBeenCalled();
				expect(context.stop).not.toHaveBeenCalled();
				expect(exit).not.toHaveBeenCalled();
				expect(context.showStatus).not.toHaveBeenCalled();
				expect(context.ui.requestRender).toHaveBeenCalled();

				await command.call(context, "session.jsonl");
				expect(context.runtimeHost.newSession).toHaveBeenCalledTimes(2);
				if (method === "handleClearCommand") {
					expect(context.chatContainer.render(200).join("\n")).toContain("New session started");
				} else {
					expect(context.showStatus).toHaveBeenCalledOnce();
				}
			} finally {
				exit.mockRestore();
				directory.dispose();
			}
		},
	);

	it("restores editor focus without disposing extension UI when reload is rejected", async () => {
		initTheme("dark");
		const directory = new ExecutionDirectory(process.cwd());
		const context = createGuardTestContext(directory);
		const reload = Reflect.get(InteractiveMode.prototype, "handleReloadCommand") as (
			this: typeof context,
		) => Promise<void>;
		try {
			await directory.run(".", () => reload.call(context));
			expect(context.resetExtensionUI).not.toHaveBeenCalled();
			expect(context.session.reload).not.toHaveBeenCalled();
			expect(context.editorContainer.children).toEqual([context.editor]);
			expect(context.ui.setFocus).toHaveBeenLastCalledWith(context.editor);
			expect(context.chatContainer.render(200).join("\n")).toContain("Reload failed:");
			expect(context.stop).not.toHaveBeenCalled();
		} finally {
			directory.dispose();
		}
	});

	it("returns a cancelled result for a scope entered during session replacement", async () => {
		initTheme("dark");
		const directory = new ExecutionDirectory(process.cwd());
		const context = createGuardTestContext(directory);
		const resume = directory.suspend();
		try {
			const error = await directory.run(".", async () => {}).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(ExecutionDirectoryBusyError);
			await expect(handleFatalRuntimeError.call(context, "Failed to fork session", error)).resolves.toEqual({
				cancelled: true,
			});
			expect(context.recordCrash).not.toHaveBeenCalled();
			expect(context.stop).not.toHaveBeenCalled();
		} finally {
			resume();
			directory.dispose();
		}
	});
});

describe("InteractiveMode live tool execution directory", () => {
	it.each(["message_update", "tool_execution_start"] as const)(
		"captures the scoped renderer cwd for %s and retains it after settlement",
		async (eventType) => {
			initTheme("dark");
			const base = mkdtempSync(join(tmpdir(), "pi-live-tool-cwd-"));
			const scoped = join(base, "worktree");
			mkdirSync(scoped);
			const directory = new ExecutionDirectory(base);
			const renderedDirectories: string[] = [];
			const renderers: ToolRenderers = {
				renderCall: (_args, _theme, context) => {
					renderedDirectories.push(context.cwd);
					return new Text(context.cwd, 0, 0);
				},
			};
			const ui = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				programStatus: { handleEvent: vi.fn() },
				session: {
					get executionDirectory() {
						return directory.cwd;
					},
				},
				sessionManager: { getCwd: () => base },
				settingsManager: { getShowImages: () => false, getImageWidthCells: () => 60 },
				streamingComponent: { updateContent: vi.fn() },
				pendingTools: new Map<string, ToolExecutionComponent>(),
				chatContainer: new Container(),
				getRegisteredToolDefinition: () => renderers,
				toolOutputExpanded: false,
				outputPad: 1,
				ui: { requestRender: vi.fn() },
			};
			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof ui,
				event: AgentSessionEvent,
			) => Promise<void>;
			const toolCall = fauxToolCall("read", { path: "item.txt" });
			const message = fauxAssistantMessage([toolCall], { stopReason: "toolUse" });
			const event: AgentSessionEvent =
				eventType === "message_update"
					? {
							type: "message_update",
							message,
							assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
						}
					: { type: "tool_execution_start", toolCallId: toolCall.id, toolName: "read", args: toolCall.arguments };
			try {
				await directory.run(scoped, () => handleEvent.call(ui, event));
				expect(renderedDirectories.length).toBeGreaterThan(0);
				expect(new Set(renderedDirectories)).toEqual(new Set([scoped]));

				renderedDirectories.length = 0;
				expect(directory.cwd).toBe(base);
				ui.pendingTools.get(toolCall.id)?.invalidate();
				expect(renderedDirectories).toEqual([scoped]);

				ui.pendingTools.clear();
				renderedDirectories.length = 0;
				await handleEvent.call(ui, event);
				expect(renderedDirectories.length).toBeGreaterThan(0);
				expect(new Set(renderedDirectories)).toEqual(new Set([base]));
			} finally {
				directory.dispose();
				rmSync(base, { recursive: true, force: true });
			}
		},
	);
});
