/**
 * /btw - Side conversation extension for pi
 *
 * Replicates the /btw slash command from Claude Code. Allows you to ask a quick
 * side question without interrupting the agent's current work.
 *
 * Usage:
 *   /btw What does this error mean?
 *   /btw How do I use async iterators in TypeScript?
 *
 * How it works:
 * - You can type /btw <question> at any time, even while the agent is busy
 * - A separate LLM call answers your question using the current model
 * - The Q&A is displayed in a widget above the editor (completely decoupled
 *   from the agent's message stream — no interruption at all)
 * - The widget auto-dismisses after 30 seconds, or press the shown shortcut
 *   (or run /btw with no arguments, e.g. in pirouette where there is no TUI)
 * - Q&A pairs are persisted via appendEntry for session replay
 * - A context filter strips btw entries from the LLM context so they never
 *   pollute the main conversation
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

const SIDE_SYSTEM_PROMPT = `You are answering a quick side question from the user. The user is currently working with a coding agent and has a question they want answered without interrupting their main task.

You have access to the recent conversation context below. Use it to give relevant answers, but keep your response concise and focused on the side question.

Be brief and helpful — keep your response to two short paragraphs or less. Avoid using code blocks as they take up a lot of vertical space in the widget. Instead, use inline code (\`backticks\`) for short snippets. Don't suggest changes to the main task or try to take over — just answer the question.`;

const DEFAULT_CONTEXT_WINDOW_TOKENS = 60_000;
const CONTEXT_FRACTION = 0.25;
const CHARS_PER_TOKEN = 3.5;
const WIDGET_DISMISS_MS = 30_000;
const WIDGET_ID = "btw-answer";

function getMaxContextChars(contextWindowTokens?: number): number {
	const tokens = contextWindowTokens && contextWindowTokens > 0 ? contextWindowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
	return Math.floor(tokens * CONTEXT_FRACTION * CHARS_PER_TOKEN);
}

function getConversationContext(entries: SessionEntry[], contextWindowTokens?: number): string {
	const messages = entries
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	const llmMessages = convertToLlm(messages);
	let text = serializeConversation(llmMessages);
	const maxContextChars = getMaxContextChars(contextWindowTokens);

	if (text.length > maxContextChars) {
		text = "...(earlier conversation truncated)...\n\n" + text.slice(-maxContextChars);
	}

	return text;
}

export default function (pi: ExtensionAPI) {
	let activeBtw = false;
	let dismissTimer: ReturnType<typeof setTimeout> | undefined;

	// ------------------------------------------------------------------
	// Context filter: strip any btw entries from the LLM context so the
	// side conversation never leaks into the agent's reasoning.
	// ------------------------------------------------------------------
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((m: any) => {
			if (m.role === "custom" && m.customType?.startsWith("btw-")) return false;
			return true;
		});
		return { messages: filtered };
	});

	// ------------------------------------------------------------------
	// Helper: show (or replace) the btw widget above the editor
	// ------------------------------------------------------------------
	function showWidget(lines: string[], ctx: { ui: { setWidget: Function; setStatus: Function } }) {
		if (dismissTimer) clearTimeout(dismissTimer);
		// Use the factory form (rather than passing `lines` directly) so each
		// line is a word-wrapping Text component. The TUI already does this for
		// string[] widgets, but pirouette renders string[] widgets verbatim in a
		// horizontally-scrolling block; with a component it renders at a fixed
		// width and gets wrapped lines back.
		ctx.ui.setWidget(WIDGET_ID, () => {
			const container = new Container();
			// Text renders nothing for an empty string, so keep blank lines as spacers.
			for (const line of lines) container.addChild(line ? new Text(line, 1, 0) : new Spacer(1));
			return container;
		});
		dismissTimer = setTimeout(() => {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			dismissTimer = undefined;
		}, WIDGET_DISMISS_MS);
	}

	function clearWidget(ctx: { ui: { setWidget: Function } }) {
		if (dismissTimer) clearTimeout(dismissTimer);
		ctx.ui.setWidget(WIDGET_ID, undefined);
		dismissTimer = undefined;
	}

	// ------------------------------------------------------------------
	// Keyboard shortcut to dismiss the widget early
	// ------------------------------------------------------------------
	pi.registerShortcut("ctrl+shift+b", {
		description: "Dismiss /btw answer widget",
		handler: async (ctx) => {
			clearWidget(ctx);
		},
	});

	// ------------------------------------------------------------------
	// /btw command
	// ------------------------------------------------------------------
	pi.registerCommand("btw", {
		description: "Ask a quick side question without interrupting the current task",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				if (dismissTimer) {
					clearWidget(ctx);
					return;
				}
				ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			if (activeBtw) {
				ctx.ui.notify("A side question is already being answered. Please wait.", "warning");
				return;
			}

			activeBtw = true;

			try {
				// Immediately show a "thinking" widget — purely UI, no agent involvement
				showWidget([`💬 /btw: ${question}`, "   Thinking..."], ctx);
				ctx.ui.setStatus("btw", "💬 side question...");

				// Build context from current conversation
				const branch = ctx.sessionManager.getBranch();
				const conversationContext = getConversationContext(branch, ctx.model.contextWindow);

				const systemPrompt = conversationContext
					? `${SIDE_SYSTEM_PROMPT}\n\n<recent_conversation_context>\n${conversationContext}\n</recent_conversation_context>`
					: SIDE_SYSTEM_PROMPT;

				const userMessage: Message = {
					role: "user",
					content: [{ type: "text", text: question }],
					timestamp: Date.now(),
				};

				// modelRegistry.complete resolves auth (API keys, OAuth, provider
				// headers/baseUrl) the same way the main agent does.
				const response = await ctx.modelRegistry.complete(ctx.model, { systemPrompt, messages: [userMessage] });
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					throw new Error(response.errorMessage || `request ${response.stopReason}`);
				}

				const answer = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();

				if (answer) {
					// Show Q&A in widget — completely outside the agent's message stream
					const widgetLines = [
						`💬 /btw: ${question}`,
						"",
						...answer.split("\n"),
						"",
						`(auto-dismisses in ${WIDGET_DISMISS_MS / 1000}s · Ctrl+Shift+B or /btw to dismiss)`,
					];
					showWidget(widgetLines, ctx);

					// Persist for session replay (appendEntry does NOT enter LLM context)
					pi.appendEntry("btw-qa", { question, answer, timestamp: Date.now() });
				} else {
					showWidget([`💬 /btw: ${question}`, "   (no response)"], ctx);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`/btw error: ${msg}`, "error");
				clearWidget(ctx);
			} finally {
				activeBtw = false;
				ctx.ui.setStatus("btw", undefined);
			}
		},
	});
}
