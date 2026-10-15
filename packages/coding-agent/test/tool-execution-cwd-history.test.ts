import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolRenderers } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createHistory() {
	initTheme("dark");
	const cwd = mkdtempSync(join(tmpdir(), "pi-historic-tool-cwd-"));
	temporaryDirectories.push(cwd);
	const session = SessionManager.create(cwd, join(cwd, "sessions"));
	const calls = ["scoped-a", "scoped-b", "legacy", "unfinished"].map((id) =>
		fauxToolCall("custom", { path: "item.txt" }, { id }),
	);
	const expectedDirectories = new Map([
		["scoped-a", join(cwd, "removed-worktree-a")],
		["scoped-b", join(cwd, "removed-worktree-b")],
		["legacy", cwd],
		["unfinished", cwd],
	]);
	session.appendMessage(fauxAssistantMessage(calls, { stopReason: "toolUse" }));
	// Results deliberately arrive in a different order from their calls.
	for (const call of calls.slice(0, 3).reverse()) {
		session.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: Date.now(),
			...(call.id.startsWith("scoped-") ? { executionCwd: expectedDirectories.get(call.id) } : {}),
		});
	}
	const rendered: Array<{ id: string; cwd: string; stage: string }> = [];
	const renderers: ToolRenderers = {
		renderCall: (_args, _theme, context) => {
			rendered.push({ id: context.toolCallId, cwd: context.cwd, stage: "call" });
			return new Text(context.cwd, 0, 0);
		},
		renderResult: (_result, options, _theme, context) => {
			rendered.push({
				id: context.toolCallId,
				cwd: context.cwd,
				stage: options.expanded ? "expanded" : "collapsed",
			});
			return new Text(context.cwd, 0, 0);
		},
	};
	return {
		cwd,
		session: SessionManager.open(session.getSessionFile()!),
		expectedDirectories,
		rendered,
		renderers,
	};
}

describe("historic tool execution directories", () => {
	it("rebuilds calls and results with their recorded cwd, falling back for legacy and unfinished calls", () => {
		const { cwd, session, expectedDirectories, rendered, renderers } = createHistory();
		const context = {
			sessionManager: session,
			// An unrelated active scope must not affect historic rendering.
			session: { executionDirectory: join(cwd, "current-scope") },
			settingsManager: {
				getShowImages: () => false,
				getImageWidthCells: () => 60,
				getShowCacheMissNotices: () => false,
			},
			pendingTools: new Map<string, ToolExecutionComponent>(),
			chatContainer: new Container(),
			getRegisteredToolDefinition: () => renderers,
			addMessageToChat: vi.fn(),
			renderSessionItems: Reflect.get(InteractiveMode.prototype, "renderSessionItems"),
			toolOutputExpanded: false,
			outputPad: 1,
			ui: { requestRender: vi.fn() },
		};
		const replay = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof context,
			entries: SessionEntry[],
		) => void;
		for (let rebuild = 0; rebuild < 2; rebuild++) {
			context.chatContainer.clear();
			rendered.length = 0;
			replay.call(context, session.buildContextEntries());
			context.chatContainer.invalidate();
			for (const [id, directory] of expectedDirectories) {
				const calls = rendered.filter((entry) => entry.id === id && entry.stage === "call");
				expect(calls.length).toBeGreaterThan(0);
				expect(new Set(calls.map((entry) => entry.cwd))).toEqual(new Set([directory]));
				const results = rendered.filter((entry) => entry.id === id && entry.stage === "collapsed");
				if (id === "unfinished") {
					expect(results).toEqual([]);
				} else {
					expect(results.length).toBeGreaterThan(0);
					expect(new Set(results.map((entry) => entry.cwd))).toEqual(new Set([directory]));
				}
			}
			expect([...context.pendingTools.keys()]).toEqual(["unfinished"]);
		}
		expect(session.getCwd()).toBe(cwd);
	});

	it("exports calls and collapsed/expanded results using matching persisted execution directories", async () => {
		const { cwd, session, expectedDirectories, rendered, renderers } = createHistory();
		const outputPath = join(cwd, "session.html");
		await exportSessionToHtml(session, undefined, {
			outputPath,
			toolRenderer: createToolHtmlRenderer({ getToolRenderers: () => renderers, theme, cwd }),
		});
		for (const [id, directory] of expectedDirectories) {
			expect(rendered.filter((entry) => entry.id === id)).toEqual([
				{ id, cwd: directory, stage: "call" },
				...(id === "unfinished"
					? []
					: [
							{ id, cwd: directory, stage: "collapsed" },
							{ id, cwd: directory, stage: "expanded" },
						]),
			]);
		}
		expect(readFileSync(outputPath, "utf8")).toContain("<!DOCTYPE html>");
		expect(session.getCwd()).toBe(cwd);
	});
});
