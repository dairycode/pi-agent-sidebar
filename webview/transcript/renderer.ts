import DOMPurify from "dompurify";
import { marked } from "marked";
import {
	parseFileReferencePayload,
	parseSelectionReferencePayload,
} from "../../shared/composerReferences.js";
import type {
	JsonRecord,
	PiContentBlock,
	PiMessage,
} from "../../shared/protocol.js";
import { objectValue, stringValue } from "../../shared/jsonValues.js";
import {
	HighlightJsHighlighter,
	resolveLanguage,
	type CodeHighlighter,
} from "./highlight.js";

marked.setOptions({ gfm: true, breaks: true });

const highlighter: CodeHighlighter = new HighlightJsHighlighter();

/**
 * Whether the current `marked.parse()` pass may highlight.
 *
 * A module-level flag rather than a renderer parameter because marked gives the
 * code renderer no user-supplied context. Safe because `marked.parse()` is
 * synchronous: the flag cannot be observed by another pass mid-parse.
 */
let highlightEnabled = false;

/**
 * Renders a fenced code block, highlighting only when it is safe and useful.
 *
 * Plain escaped text is emitted for streaming messages, unknown or absent
 * language tags, and oversized blocks. The `<pre>` wrapper is preserved because
 * `enhanceCodeBlocks` finds it to attach the copy button.
 */
marked.use({
	renderer: {
		code({ text, lang }): string {
			const language = resolveLanguage(lang ?? "");
			const highlighted =
				highlightEnabled && language
					? highlighter.highlight(text, lang ?? "")
					: undefined;
			// The language class is emitted even without highlighting so the block
			// still reports its language to the DOM and to assistive technology.
			const classAttribute = language
				? ` class="hljs language-${escapeHtml(language)}"`
				: ' class="hljs"';
			return `<pre><code${classAttribute}>${highlighted ?? escapeHtml(text)}</code></pre>`;
		},
	},
});

export interface TranscriptLiveTool {
	id: string;
	name: string;
	args: JsonRecord;
	status: "running" | "success" | "error";
	output: string;
	diff?: string;
	startedAt: number;
	/**
	 * Bumped by the owner on every in-place mutation.
	 *
	 * Live tools are updated in place rather than replaced, so object identity
	 * cannot tell `messageRenderSignature` that the output grew.
	 */
	revision: number;
}

/**
 * True when `messageHtml` would produce markup for this message.
 *
 * Decided from the role alone so callers can drop invisible messages without
 * paying for a markdown parse to discover the result is empty.
 */
export function isRenderableMessage(message: PiMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "compactionSummary":
		case "branchSummary":
			return true;
		case "custom":
			return message.display !== false;
		default:
			return false;
	}
}

/**
 * Everything `messageHtml` reads, condensed into a comparable string.
 *
 * This is what makes incremental transcript rendering possible: an unchanged
 * signature means the existing DOM node is still correct, so the expensive path
 * (markdown parse, sanitize, HTML parse, node replacement) is skipped. It must
 * therefore cover every input `messageHtml` consults — a missed input shows up
 * as a message that stops updating, so prefer over-invalidating when unsure.
 *
 * Message content is covered by `identityOf` rather than inspected: pi replaces
 * message objects on every change instead of mutating them, so a per-object
 * identity marker is both cheaper and more exact than hashing content.
 */
export function messageRenderSignature(
	message: PiMessage,
	results: ReadonlyMap<string, PiMessage>,
	liveTools: ReadonlyMap<string, TranscriptLiveTool>,
	streaming: boolean,
	identityOf: (message: PiMessage) => string,
): string {
	const parts = [`m${identityOf(message)}`, streaming ? "s1" : "s0"];
	const blocks = Array.isArray(message.content) ? message.content : [];
	for (const block of blocks) {
		if (block.type !== "toolCall" || !block.id) continue;
		const live = liveTools.get(block.id);
		const result = results.get(block.id);
		parts.push(
			`t${block.id}:${live ? `${live.status}.${live.revision}` : "-"}:${
				result ? `${identityOf(result)}.${result.isError ? 1 : 0}` : "-"
			}`,
		);
	}
	return parts.join("|");
}

export function messageHtml(
	message: PiMessage,
	results: ReadonlyMap<string, PiMessage>,
	liveTools: ReadonlyMap<string, TranscriptLiveTool>,
	streaming: boolean,
	messageKey: string,
): string {
	if (message.role === "toolResult") return "";
	if (message.role === "user") return userMessageHtml(message);
	if (message.role === "assistant") {
		return assistantMessageHtml(
			message,
			results,
			liveTools,
			streaming,
			messageKey,
		);
	}
	if (message.role === "bashExecution") {
		return `<div class="message system-message">${toolCallHtml(
			"bash-execution",
			"bash",
			{ command: message.command },
			undefined,
			{
				id: "bash-execution",
				name: "bash",
				args: { command: message.command },
				status: message.exitCode === 0 ? "success" : "error",
				output: stringValue(message.output),
				startedAt: 0,
				revision: 0,
			},
		)}</div>`;
	}
	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		return '<div class="context-divider"><i class="codicon codicon-fold"></i> Context summarized</div>';
	}
	if (message.role === "custom" && message.display !== false) {
		return `<div class="message system-message custom-message">${markdown(contentText(message.content), true)}</div>`;
	}
	return "";
}

function userMessageHtml(message: PiMessage): string {
	const rawText = contentText(message.content);
	const skill = parseSkillBlock(rawText);
	if (skill) return skillMessageHtml(skill);
	const contextMatch = rawText.match(
		/^<pi-context>\n([\s\S]*?)\n<\/pi-context>\n\n/u,
	);
	const context = contextMatch?.[1] ?? "";
	const text = contextMatch ? rawText.slice(contextMatch[0].length) : rawText;
	const markers = context
		.split("\n")
		.map(contextInlineMarker)
		.filter((marker): marker is InlineMarker => Boolean(marker));
	const bodyHtml = renderUserBodyHtml(text, markers);
	const imageHtml = contentImages(message.content)
		.map(
			(image) =>
				`<img class="message-image" src="data:${escapeHtml(image.mimeType ?? "image/png")};base64,${image.data ?? ""}" alt="Attached image">`,
		)
		.join("");
	return `<article class="message user-message"><div class="user-message-text">${bodyHtml}</div>${imageHtml}</article>`;
}

/**
 * One `<skill>` payload pi inlines into a user turn when a `/skill:name`
 * command expands, plus whatever text the reader typed after the command.
 *
 * The regex mirrors pi's `parseSkillBlock` (pi core/agent-session.js), the same
 * shape its TUI matches before collapsing the block into a `[skill]` card —
 * dumping the whole SKILL.md into the user bubble instead would bury the
 * reader's own words under a screenful of markdown source.
 */
interface SkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string;
}

function parseSkillBlock(text: string): SkillBlock | undefined {
	const match = text.match(
		/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/u,
	);
	if (!match) return undefined;
	return {
		name: match[1] ?? "",
		location: match[2] ?? "",
		content: match[3] ?? "",
		userMessage: match[4] ?? "",
	};
}

/**
 * A skill invocation, split the way pi's TUI splits it: the SKILL.md payload
 * becomes a collapsed `[skill] name` card (expand to read the rendered
 * markdown), and the arguments typed after the command stay a separate user
 * bubble below it.
 *
 * The card is its own control carrying the same `data-expandable` contract as
 * a tool box — this webview's CSP forbids inline handlers, so toggling goes
 * through the delegated handler in `main.ts`, and the file path rides in the
 * `title` because the card itself has no room for it.
 */
function skillMessageHtml(skill: SkillBlock): string {
	const lines = skill.content.replace(/\n$/u, "").split("\n").length;
	const hint = `<span class="skill-hint">${lines} ${lines === 1 ? "line" : "lines"}</span>`;
	const header = `<div class="skill-header"><span class="skill-label">[skill]</span> <span class="skill-name">${escapeHtml(skill.name)}</span>${hint}</div>`;
	const body = `<div class="skill-body">${markdown(skill.content, true)}</div>`;
	const card = `<div class="skill-block expandable" data-expandable="skill" data-skill-key="${escapeHtml(skill.name)}" role="button" tabindex="0" aria-expanded="false" title="${escapeHtml(skill.location)}">${header}${body}</div>`;
	if (!skill.userMessage) return card;
	const messageHtml = renderUserBodyHtml(skill.userMessage, []);
	return `${card}<article class="message user-message"><div class="user-message-text">${messageHtml}</div></article>`;
}

function markerSpanHtml(marker: InlineMarker): string {
	const resourceAttr = marker.resourceUri
		? ` data-resource-uri="${escapeHtml(marker.resourceUri)}"`
		: marker.workspacePath
			? ` data-workspace-path="${escapeHtml(marker.workspacePath)}"`
			: "";
	const lineAttr = marker.line ? ` data-workspace-line="${marker.line}"` : "";
	return `<span class="composer-reference-highlight"${resourceAttr}${lineAttr}>${escapeHtml(marker.label)}</span>`;
}

function renderUserBodyHtml(text: string, markers: InlineMarker[]): string {
	const inline: Array<{ start: number; end: number; marker: InlineMarker }> = [];
	const leftover: InlineMarker[] = [];
	let searchFrom = 0;
	for (const marker of markers) {
		const index = text.indexOf(marker.label, searchFrom);
		if (index >= 0) {
			inline.push({ start: index, end: index + marker.label.length, marker });
			searchFrom = index + marker.label.length;
		} else {
			leftover.push(marker);
		}
	}
	let body = "";
	let cursor = 0;
	for (const { start, end, marker } of inline) {
		body += escapeHtml(text.slice(cursor, start));
		body += markerSpanHtml(marker);
		cursor = end;
	}
	body += escapeHtml(text.slice(cursor));
	const prefix = leftover.map(markerSpanHtml).join(" ");
	if (!prefix) return body;
	return body ? `${prefix} ${body}` : prefix;
}

interface InlineMarker {
	label: string;
	resourceUri?: string;
	workspacePath?: string;
	line?: number;
}

function contextInlineMarker(line: string): InlineMarker | undefined {
	const resourcePrefixes = ["- file: ", "- directory: "] as const;
	const resourcePrefix = resourcePrefixes.find((prefix) =>
		line.startsWith(prefix),
	);
	if (resourcePrefix) {
		const value = line.slice(resourcePrefix.length);
		const reference = parseFileReferencePayload(value);
		if (reference) {
			return {
				label: reference.marker,
				resourceUri: reference.uri,
				workspacePath: reference.displayPath,
			};
		}
		try {
			const resourcePath = JSON.parse(value) as unknown;
			if (typeof resourcePath !== "string") {
				return {
					label: resourcePrefix === "- directory: " ? "@folder/" : "@file",
				};
			}
			const name = resourcePath.split(/[/\\]/u).pop() || resourcePath;
			return {
				label: resourcePrefix === "- directory: " ? `@${name}/` : `@${name}`,
			};
		} catch {
			return {
				label: resourcePrefix === "- directory: " ? "@folder/" : "@file",
			};
		}
	}
	if (line.startsWith("- symbol: ") || line.startsWith("- diagnostics: ")) {
		return undefined;
	}
	const selectionPrefix = "- selection: ";
	if (!line.startsWith(selectionPrefix)) return undefined;
	const reference = parseSelectionReferencePayload(
		line.slice(selectionPrefix.length),
	);
	if (!reference) return undefined;
	return {
		label: reference.marker,
		resourceUri: reference.uri,
		workspacePath: reference.displayPath,
		line: reference.startLine,
	};
}

function assistantMessageHtml(
	message: PiMessage,
	results: ReadonlyMap<string, PiMessage>,
	liveTools: ReadonlyMap<string, TranscriptLiveTool>,
	streaming: boolean,
	messageKey: string,
): string {
	return `<article class="message assistant-message">${assistantMessageSections(
		message,
		results,
		liveTools,
		streaming,
		messageKey,
	)
		.map((section) => section.html)
		.join("")}</article>`;
}

/**
 * One renderable region of an assistant message, keyed for incremental updates.
 *
 * Streaming calls `messageHtml` once per delta; the HTML that produces already
 * rendered parts is re-parsed and the whole message node rebuilt on every
 * frame. Codex and similar UIs keep the node stable instead and only rewrite
 * the part that changed. `assistantMessageSections` is the piece that makes
 * that possible: each returned `html` is independently renderable and carries a
 * stable `key` (an incrementing ordinal per content block) plus a `hash` of its
 * own content. The caller rebuilds a section only when its hash changed, and
 * reuses the previous DOM node otherwise, so the bytes that didn't change are
 * never re-parsed, re-laid-out, or re-painted.
 *
 * Keys are ordinals in render order, not content indices: tool calls stream
 * their arguments/status in place, and merges into the shared activity timeline
 * must not shift keys of the sections before them. Because deltas only ever
 * append blocks (a run starts with thinking, then text, then tool calls), the
 * leading sections of an earlier frame always match the leading sections of the
 * next, which is exactly the alignment an in-place updater needs.
 */
export function assistantMessageSections(
	message: PiMessage,
	results: ReadonlyMap<string, PiMessage>,
	liveTools: ReadonlyMap<string, TranscriptLiveTool>,
	streaming: boolean,
	messageKey: string,
): Array<{ key: string; hash: string; html: string }> {
	const blocks = Array.isArray(message.content) ? message.content : [];
	const sections: Array<{ key: string; hash: string; html: string }> = [];
	let activity: string[] = [];
	let activityOrdinal = 0;
	let contentOrdinal = 0;
	let thinkingIndex = 0;
	const flushActivity = (): void => {
		if (activity.length === 0) return;
		const html = `<div class="activity-timeline">${activity.join("")}</div>`;
		const key = `activity-${activityOrdinal}`;
		const hash = contentHash(html);
		sections.push({ key, hash, html: withSectionMarker(html, key, hash) });
		activityOrdinal += 1;
		activity = [];
	};

	for (const block of blocks) {
		if (block.type === "text") {
			flushActivity();
			const html = `<div class="assistant-text">${markdown(block.text ?? "", !streaming)}</div>`;
			const key = `content-${contentOrdinal}`;
			const hash = contentHash(html);
			sections.push({ key, hash, html: withSectionMarker(html, key, hash) });
			contentOrdinal += 1;
		}
		if (block.type === "thinking") {
			const thinkingKey = `${messageKey}-thinking-${thinkingIndex}`;
			const streamingState = streaming ? " streaming" : "";
			thinkingIndex += 1;
			activity.push(thinkingBlockHtml(thinkingKey, streamingState, block));
		}
		if (block.type === "toolCall" && block.id && block.name) {
			activity.push(
				toolCallHtml(
					block.id,
					block.name,
					block.arguments ?? {},
					results.get(block.id),
					liveTools.get(block.id),
				),
			);
		}
	}
	flushActivity();
	if (message.errorMessage) {
		const html = `<div class="message-error">${escapeHtml(message.errorMessage)}</div>`;
		const hash = contentHash(html);
		sections.push({
			key: `error`,
			hash,
			html: withSectionMarker(html, "error", hash),
		});
	}
	if (message.stopReason === "aborted") {
		const html = '<div class="cancelled-note">Cancelled</div>';
		const hash = contentHash(html);
		sections.push({
			key: `cancelled`,
			hash,
			html: withSectionMarker(html, "cancelled", hash),
		});
	}
	return sections;
}

/**
 * Wraps a section's root element with the bookkeeping the streaming patcher
 * needs, so even a first frame (built wholesale) produces DOM that later
 * incremental frames can match — the patcher never pays a full rebuild to
 * learn that nothing changed.
 */
function withSectionMarker(html: string, key: string, hash: string): string {
	// The sections this module emits are single-rooted elements (divs); the
	// marker goes on that root only.
	const rootEnd = html.search(/>/u);
	if (rootEnd < 0) return html;
	const rootTag = html.slice(0, rootEnd);
	if (!/^<[a-z]+(?:\s|$)/iu.test(rootTag)) return html;
	const marker = ` data-section-key="${escapeHtml(key)}" data-section-hash="${hash}"`;
	return `${rootTag}${marker}${html.slice(rootEnd)}`;
}

/** FNV-1a, 32-bit. Cheap enough to run per section per frame, stable across runs. */
function contentHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/**
 * Reasoning, rendered the way pi renders it: italic `thinkingText` with a
 * collapsed placeholder swapped in for it.
 *
 * Visible while it streams, collapsed once it settles. Reasoning is live
 * progress — it is the only thing to watch before the answer starts, and dead
 * weight above the answer afterwards. A streaming block therefore has no
 * collapse control (there is nothing stable to collapse to yet) and a settled
 * one starts collapsed; `restoreExpandableState` skips streaming keys, so the
 * settled block that replaces it inherits no state and takes that default,
 * which is what makes the collapse automatic.
 *
 * pi drives the same pair from one global header toggle. There is no such header
 * here, so the block is its own control and carries the ARIA button contract
 * that the `<summary>` it replaced used to provide for free.
 */
function thinkingBlockHtml(
	thinkingKey: string,
	streamingState: string,
	block: PiContentBlock,
): string {
	const body = markdown(block.thinking ?? "");
	if (streamingState) {
		return `<div class="activity-item thinking-block streaming is-expanded" data-thinking-key="${escapeHtml(thinkingKey)}"><div class="thinking-text">${body}</div></div>`;
	}
	return `<div class="activity-item thinking-block" data-thinking-key="${escapeHtml(thinkingKey)}" data-expandable="thinking" role="button" tabindex="0" aria-expanded="false" aria-label="Reasoning, click to expand"><div class="thinking-text">${body}</div><div class="thinking-collapsed">Thinking …</div></div>`;
}

/**
 * One tool call as pi draws it: a filled box whose tint is the entire status
 * indicator, a bold header, and the output directly beneath with no nested
 * surface of its own.
 *
 * Two things pi can leave out and this cannot. Colour is pi's only status
 * channel, which fails WCAG 1.4.1 on its own, so the state is also carried as
 * visually-hidden text and `running` keeps a spinner — a still frame cannot
 * otherwise distinguish "in progress" from "finished". The status rides in a
 * `.sr-only` span rather than an `aria-label` so the accessible name still
 * includes the tool name and path the header shows. And pi toggles output with
 * an inline `onclick`, which this webview's CSP forbids, so the box is marked
 * with `data-expandable` for the delegated handler in `main.ts`.
 *
 * Collapsed to its header by default. A settled call is a record of something
 * that already happened, and a transcript of expanded outputs buries the prose
 * that explains them. Only a box with something to reveal becomes a button:
 * giving an output-less call a button role would promise an expansion that never
 * arrives.
 */
function toolCallHtml(
	id: string,
	name: string,
	args: JsonRecord,
	result?: PiMessage,
	live?: TranscriptLiveTool,
): string {
	const status = resolveToolStatus(result, live);
	const output = live?.output || (result ? contentText(result.content) : "");
	const diff = live?.diff ?? (result ? extractResultDiff(result) : "");
	const diffHtml = status === "success" && diff ? renderDiffBlock(diff) : "";
	const outputHtml =
		output && !diffHtml
			? `<div class="tool-output"><pre>${escapeHtml(truncate(output, 20_000))}</pre></div>`
			: "";
	const body = `${outputHtml}${diffHtml}`;
	const spinner =
		status === "running"
			? '<i class="codicon codicon-loading codicon-modifier-spin tool-spinner" aria-hidden="true"></i>'
			: "";
	const statusNote = `<span class="sr-only">${escapeHtml(`${friendlyToolName(name)}: ${toolStatusLabel(status)}`)}</span>`;
	if (!body) {
		return `<div class="activity-item tool-call ${status}">${statusNote}${toolHeaderHtml(name, args, spinner, "")}</div>`;
	}
	// The hint is the only thing a collapsed box says about what it is hiding, so
	// it counts the body actually rendered — a diff, or the raw output.
	const hint = lineCountHint(diffHtml ? diff : output);
	return `<div class="activity-item tool-call ${status} expandable" data-tool-key="${escapeHtml(id)}" data-expandable="tool" role="button" tabindex="0" aria-expanded="false">${statusNote}${toolHeaderHtml(name, args, spinner, hint)}${body}</div>`;
}

/**
 * How much a collapsed box is holding back.
 *
 * No accessible-name concern here: the box takes its name from its contents, so
 * this rides along with the tool name and path instead of being hidden from
 * assistive tech the way a decorative marker would be.
 */
function lineCountHint(text: string): string {
	const lines = text.replace(/\n$/u, "").split("\n").length;
	return `<span class="tool-hint">${lines} ${lines === 1 ? "line" : "lines"}</span>`;
}

const MAX_TOOL_TARGET_LENGTH = 2000;

/**
 * The box's first line — and, collapsed, the only line.
 *
 * pi splits this by tool: a shell command becomes `$ …` on its own bold,
 * wrapping line, while every other tool gets `name` followed by its primary
 * argument. Commands are not truncated or ellipsised the way a one-line summary
 * would be — the command *is* the content, and a clipped one cannot be checked
 * against what actually ran.
 */
function toolHeaderHtml(
	name: string,
	args: JsonRecord,
	spinner: string,
	hint: string,
): string {
	// The spinner goes at the end of the line, never at the start: a leading
	// inline element costs the header its column position when the call settles
	// and it is removed, which shifts `$ command` (or the tool name) by the
	// spinner's width in the same frame the box changes colour. Trailing, it
	// vanishes into the line that was there anyway and nothing moves.
	if (name === "bash") {
		const command = truncate(stringValue(args.command), MAX_TOOL_TARGET_LENGTH);
		return `<div class="tool-command">$ ${escapeHtml(command)}${hint}${spinner}</div>`;
	}
	const target = truncate(toolTarget(args), MAX_TOOL_TARGET_LENGTH);
	const targetHtml = target
		? ` <span class="tool-path">${escapeHtml(target)}</span>`
		: "";
	return `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span>${targetHtml}${hint}${spinner}</div>`;
}

const MAX_DIFF_LINES = 400;

function renderDiffBlock(diff: string): string {
	const lines = diff.replace(/\n$/u, "").split("\n");
	const truncated = lines.length > MAX_DIFF_LINES;
	const shown = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;
	const rows = shown
		.map((line) => {
			const marker = line.charAt(0);
			const kind = marker === "+" ? "add" : marker === "-" ? "remove" : "context";
			return `<div class="diff-line diff-${kind}"><span class="diff-text">${escapeHtml(line) || "&nbsp;"}</span></div>`;
		})
		.join("");
	const more = truncated
		? `<div class="diff-line diff-context"><span class="diff-text">… ${lines.length - MAX_DIFF_LINES} more lines</span></div>`
		: "";
	return `<div class="tool-diff">${rows}${more}</div>`;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const value of content) {
		if (!value || typeof value !== "object") continue;
		const block = value as PiContentBlock;
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}

function contentImages(content: unknown): PiContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is PiContentBlock =>
		Boolean(block && typeof block === "object" && block.type === "image"),
	);
}

/**
 * Markdown to sanitized HTML.
 *
 * `highlight` is off by default: highlighting a streaming message would re-run
 * the highlighter on every delta, and pi replaces the message object each time.
 * Only settled content opts in.
 */
function markdown(text: string, highlight = false): string {
	highlightEnabled = highlight;
	try {
		return DOMPurify.sanitize(marked.parse(text) as string, {
			USE_PROFILES: { html: true },
			ADD_ATTR: ["target", "rel"],
		});
	} finally {
		// Reset unconditionally: a throw must not leave highlighting armed for the
		// next, possibly streaming, pass.
		highlightEnabled = false;
	}
}

function toolTarget(args: JsonRecord): string {
	return (
		stringValue(args.path) ||
		stringValue(args.file_path) ||
		stringValue(args.pattern) ||
		stringValue(args.query) ||
		""
	);
}

function resolveToolStatus(
	result?: PiMessage,
	live?: TranscriptLiveTool,
): TranscriptLiveTool["status"] {
	if (live) return live.status;
	if (!result) return "running";
	return result.isError ? "error" : "success";
}

function toolStatusLabel(status: TranscriptLiveTool["status"]): string {
	if (status === "running") return "running";
	return status === "error" ? "failed" : "done";
}

export function friendlyToolName(name: string): string {
	const labels: Record<string, string> = {
		bash: "Run command",
		read: "Read file",
		write: "Write file",
		edit: "Edit file",
		grep: "Search text",
		find: "Find files",
		ls: "List files",
	};
	return labels[name] ?? name.replaceAll("_", " ");
}

export function extractResultDiff(result: unknown): string {
	const record = objectValue(result);
	const details = objectValue(record.details);
	return stringValue(details.diff);
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/gu,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
}

function truncate(value: string, length: number): string {
	return value.length > length
		? `${value.slice(0, Math.max(0, length - 1))}…`
		: value;
}
