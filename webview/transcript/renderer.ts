import DOMPurify from "dompurify";
import { marked, type Token, type Tokens } from "marked";
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
	/** Raw pi result retained until the reader expands the collapsed card. */
	result?: unknown;
	/** Legacy/test inputs; the webview hot path stores `result` instead. */
	output?: string;
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
export interface AssistantMessageSection {
	key: string;
	hash: string;
	html: string;
	streamUpdate?: {
		selector?: string;
		text: string;
		format: "markdown" | "plain";
	};
}

export function assistantMessageSections(
	message: PiMessage,
	results: ReadonlyMap<string, PiMessage>,
	liveTools: ReadonlyMap<string, TranscriptLiveTool>,
	streaming: boolean,
	messageKey: string,
	deferStreamingTextHtml = false,
): AssistantMessageSection[] {
	const blocks = Array.isArray(message.content) ? message.content : [];
	const sections: AssistantMessageSection[] = [];
	type ActivityEntry = {
		signature: string;
		render: (omitThinkingText: boolean) => string;
		thinking?: PiContentBlock;
	};
	let activity: ActivityEntry[] = [];
	let activityOrdinal = 0;
	let contentOrdinal = 0;
	let thinkingIndex = 0;
	const flushActivity = (): void => {
		if (activity.length === 0) return;
		const firstActivity = activity[0];
		const onlyThinking =
			activity.length === 1 && firstActivity?.thinking
				? firstActivity.thinking
				: undefined;
		const streamText =
			streaming && onlyThinking ? (onlyThinking.thinking ?? "") : undefined;
		const omitThinkingText = Boolean(deferStreamingTextHtml && onlyThinking);
		const cacheKey = `${messageKey}:${activityOrdinal}:${streaming ? 1 : 0}:${deferStreamingTextHtml ? 1 : 0}`;
		const signature = `${activity.map((entry) => entry.signature).join("|")}|omit:${omitThinkingText ? 1 : 0}`;
		let cached = activitySectionCache.get(cacheKey);
		if (cached?.signature !== signature) {
			const body = activity
				.map((entry) => entry.render(omitThinkingText && Boolean(entry.thinking)))
				.join("");
			const html = `<div class="activity-timeline">${body}</div>`;
			cached = { signature, body, hash: contentHash(html) };
			setActivitySectionCache(cacheKey, cached);
		}

		const html = `<div class="activity-timeline">${cached.body}</div>`;
		const key = `activity-${activityOrdinal}`;
		const hash =
			streamText === undefined ? cached.hash : streamingTextHash(streamText);
		sections.push({
			key,
			hash,
			html: withSectionMarker(html, key, hash, streamText?.length),
			streamUpdate:
				streamText === undefined
					? undefined
					: {
							selector: ".thinking-text",
							text: streamText,
							format: "markdown",
						},
		});
		activityOrdinal += 1;
		activity = [];
	};

	for (const block of blocks) {
		if (block.type === "text") {
			flushActivity();
			const streamText = streaming ? (block.text ?? "") : undefined;
			const body =
				streamText === undefined
					? markdown(block.text ?? "", true)
					: deferStreamingTextHtml
						? ""
						: markdown(streamText);
			const html = `<div class="assistant-text">${body}</div>`;
			const key = `content-${contentOrdinal}`;
			const hash =
				streamText === undefined
					? contentHash(html)
					: streamingTextHash(streamText);
			sections.push({
				key,
				hash,
				html: withSectionMarker(html, key, hash, streamText?.length),
				streamUpdate:
					streamText === undefined
						? undefined
						: { text: streamText, format: "markdown" },
			});
			contentOrdinal += 1;
		}
		if (block.type === "thinking") {
			const thinkingKey = `${messageKey}-thinking-${thinkingIndex}`;
			const streamingState = streaming ? " streaming" : "";
			thinkingIndex += 1;
			activity.push({
				signature: `thinking:${objectIdentity(block)}:${streamingState}`,
				thinking: block,
				render: (omitThinkingText) =>
					thinkingBlockHtml(
						thinkingKey,
						streamingState,
						omitThinkingText ? { ...block, thinking: "" } : block,
					),
			});
		}
		if (block.type === "toolCall" && block.id && block.name) {
			const result = results.get(block.id);
			const live = liveTools.get(block.id);
			activity.push({
				signature: `tool:${objectIdentity(block)}:${objectIdentity(result)}:${live?.status ?? "-"}:${live?.revision ?? -1}`,
				render: () =>
					toolCallHtml(
						block.id ?? "",
						block.name ?? "tool",
						block.arguments ?? {},
						result,
						live,
					),
			});
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
function withSectionMarker(
	html: string,
	key: string,
	hash: string,
	streamLength?: number,
): string {
	// The sections this module emits are single-rooted elements (divs); the
	// marker goes on that root only.
	const rootEnd = html.search(/>/u);
	if (rootEnd < 0) return html;
	const rootTag = html.slice(0, rootEnd);
	if (!/^<[a-z]+(?:\s|$)/iu.test(rootTag)) return html;
	const streamMarker =
		streamLength === undefined ? "" : ` data-stream-length="${streamLength}"`;
	const marker = ` data-section-key="${escapeHtml(key)}" data-section-hash="${hash}"${streamMarker}`;
	return `${rootTag}${marker}${html.slice(rootEnd)}`;
}

const activitySectionCache = new Map<
	string,
	{ signature: string; body: string; hash: string }
>();
const MAX_ACTIVITY_SECTION_CACHE = 256;
const objectIdentityMap = new WeakMap<object, number>();
let nextObjectIdentity = 0;

function objectIdentity(value: object | undefined): number {
	if (!value) return 0;
	const existing = objectIdentityMap.get(value);
	if (existing !== undefined) return existing;
	nextObjectIdentity += 1;
	objectIdentityMap.set(value, nextObjectIdentity);
	return nextObjectIdentity;
}

function setActivitySectionCache(
	key: string,
	value: { signature: string; body: string; hash: string },
): void {
	activitySectionCache.delete(key);
	activitySectionCache.set(key, value);
	if (activitySectionCache.size <= MAX_ACTIVITY_SECTION_CACHE) return;
	const oldest = activitySectionCache.keys().next().value;
	if (oldest !== undefined) activitySectionCache.delete(oldest);
}

/** O(1) marker for append-only streaming text; settled content gets a full hash. */
function streamingTextHash(value: string): string {
	if (value.length === 0) return "s0";
	return `s${value.length.toString(36)}x${value.charCodeAt(0).toString(36)}x${value
		.charCodeAt(value.length - 1)
		.toString(36)}`;
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
	const rawText = block.thinking ?? "";
	if (streamingState) {
		return `<div class="activity-item thinking-block streaming is-expanded" data-thinking-key="${escapeHtml(thinkingKey)}"><div class="thinking-text">${markdown(rawText)}</div></div>`;
	}
	const body = markdown(rawText);
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
	const hasBody = Boolean(
		live
			? live.result !== undefined || live.output || live.diff
			: result !== undefined,
	);
	const spinner =
		status === "running"
			? '<i class="codicon codicon-loading codicon-modifier-spin tool-spinner" aria-hidden="true"></i>'
			: "";
	const statusNote = `<span class="sr-only">${escapeHtml(`${friendlyToolName(name)}: ${toolStatusLabel(status)}`)}</span>`;
	if (!hasBody) {
		return `<div class="activity-item tool-call ${status}">${statusNote}${toolHeaderHtml(name, args, spinner, "")}</div>`;
	}
	// The collapsed hot path carries only the header. Large output and diffs are
	// materialized by the delegated click handler when the reader asks to expand.
	// Avoid even counting lines here: tool_end must remain constant-time with
	// respect to result size so the next assistant text frame is never delayed.
	const hint = '<span class="tool-hint">output</span>';
	return `<div class="activity-item tool-call ${status} expandable" data-tool-key="${escapeHtml(id)}" data-tool-body="lazy" data-expandable="tool" role="button" tabindex="0" aria-expanded="false">${statusNote}${toolHeaderHtml(name, args, spinner, hint)}</div>`;
}

/** Builds a tool body on demand instead of parsing hidden output at tool end. */
export function toolBodyHtml(
	result?: PiMessage,
	live?: TranscriptLiveTool,
): string {
	const status = resolveToolStatus(result, live);
	const rawResult = live?.result;
	const output =
		live?.output ??
		(rawResult === undefined
			? result
				? contentText(result.content)
				: ""
			: resultContentText(rawResult));
	const diff =
		live?.diff ??
		(rawResult === undefined
			? result
				? extractResultDiff(result)
				: ""
			: extractResultDiff(rawResult));
	if (status === "success" && diff) return renderDiffBlock(diff);
	return output
		? `<div class="tool-output"><pre>${escapeHtml(truncate(output, MAX_TOOL_OUTPUT_LENGTH))}</pre></div>`
		: "";
}

function resultContentText(value: unknown): string {
	const content = objectValue(value).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const text = stringValue(objectValue(item).text);
		if (text) parts.push(text);
	}
	return parts.join("\n");
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

const MAX_TOOL_OUTPUT_LENGTH = 20_000;
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

type StreamingMarkdownAppendMode = "none" | "plain" | "code";

export interface StreamingMarkdownParts {
	/** Newly stable top-level tokens, rendered once and never touched again. */
	stableHtml: string;
	/** The one top-level token that may still absorb future characters. */
	activeHtml: string;
	/** Absolute source offset after the newly stable token prefix. */
	stableSourceLength: number;
	/** How the next suffix may update the active DOM without reparsing it. */
	appendMode: StreamingMarkdownAppendMode;
	/** Non-local Markdown (notably reference definitions) invalidated the prefix. */
	reset: boolean;
}

/**
 * Splits an append-only Markdown stream into immutable prefix and active tail.
 *
 * Marked's top-level tokens carry their exact raw source. Keeping the final
 * token active is the crucial correctness rule: a paragraph may gain emphasis,
 * a list may gain items, and an unterminated fence may gain arbitrary lines.
 * Once a later top-level token exists, the previous one cannot absorb more
 * source and can be mounted permanently. Each frame therefore lexes only the
 * unfinished tail, not the full assistant response.
 */
export function streamingMarkdownParts(
	text: string,
	stableSourceLength = 0,
): StreamingMarkdownParts {
	const safeStableLength =
		Number.isSafeInteger(stableSourceLength) &&
		stableSourceLength >= 0 &&
		stableSourceLength <= text.length
			? stableSourceLength
			: 0;
	const remainingText = text.slice(safeStableLength);
	const tokens = marked.lexer(remainingText);
	if (tokens.length === 0) {
		if (remainingText.length > 0) {
			return {
				stableHtml: "",
				activeHtml: markdown(text),
				stableSourceLength: 0,
				appendMode: "none",
				reset: true,
			};
		}
		return {
			stableHtml: "",
			activeHtml: "",
			stableSourceLength: safeStableLength,
			appendMode: "none",
			reset: false,
		};
	}
	const tokenSourceLength = tokens.reduce(
		(total, token) => total + token.raw.length,
		0,
	);
	if (tokenSourceLength !== remainingText.length) {
		// Marked removes reference definitions from the emitted token list and keeps
		// them in `tokens.links`. They can retroactively change already mounted
		// paragraphs, so abandon the prefix cache and render the authoritative full
		// stream until the non-local construct is complete.
		return {
			stableHtml: "",
			activeHtml: markdown(text),
			stableSourceLength: 0,
			appendMode: "none",
			reset: true,
		};
	}
	const stableTokens = tokens.slice(0, -1);
	const activeTokens = tokens.slice(-1);
	const newlyStableLength = stableTokens.reduce(
		(total, token) => total + token.raw.length,
		0,
	);
	const activeToken = activeTokens[0];
	return {
		stableHtml: markdownTokens(stableTokens),
		activeHtml: activeToken ? streamingActiveTokenHtml(activeToken) : "",
		stableSourceLength: safeStableLength + newlyStableLength,
		appendMode: activeToken ? tokenAppendMode(activeToken) : "none",
		reset: false,
	};
}

function streamingActiveTokenHtml(token: Token): string {
	if (token.type === "code") {
		return markdownTokens([stabilizeStreamingCodeToken(token)]);
	}
	const stableToken = stabilizeStreamingToken(token);
	return stableToken ? markdownTokens([stableToken]) : "";
}

/**
 * Reuses marked's block token tree and only re-lexes the growing inline leaf.
 * A long list is one top-level token, so parsing `token.raw` again here would
 * make every list-item boundary process the entire response twice.
 */
function stabilizeStreamingToken(token: Token): Token | undefined {
	if (token.type === "list") {
		const list = token as Tokens.List;
		const lastItem = list.items.at(-1);
		if (!lastItem) return token;
		if (isEmptyStreamingListItem(lastItem)) {
			const stableItems = list.items.slice(0, -1);
			return stableItems.length > 0 ? { ...list, items: stableItems } : undefined;
		}
		const stableItem = stabilizeStreamingListItem(lastItem);
		if (!stableItem) return token;
		return { ...list, items: [...list.items.slice(0, -1), stableItem] };
	}
	if (token.type === "blockquote") {
		const blockquote = token as Tokens.Blockquote;
		const stableTokens = stabilizeLastStreamingToken(blockquote.tokens);
		return { ...blockquote, tokens: stableTokens };
	}
	if (
		token.type === "heading" &&
		isPendingSetextHeading(token as Tokens.Heading)
	) {
		const heading = token as Tokens.Heading;
		return {
			type: "paragraph",
			raw: heading.raw,
			text: heading.text,
			tokens: heading.tokens,
		};
	}
	if (
		token.type === "paragraph" ||
		token.type === "heading" ||
		token.type === "text"
	) {
		return stabilizeStreamingInlineToken(
			token as Tokens.Paragraph | Tokens.Heading | Tokens.Text,
		);
	}
	return token;
}

function isPendingSetextHeading(token: Tokens.Heading): boolean {
	return /(?:^|\n) {0,3}(?:=+|-+)[ \t]*(?:\n)?$/u.test(token.raw);
}

function isEmptyStreamingListItem(item: Tokens.ListItem): boolean {
	return item.tokens.length === 0 && item.text.trim().length === 0;
}

function stabilizeStreamingListItem(
	item: Tokens.ListItem,
): Tokens.ListItem | undefined {
	const tokens = stabilizeLastStreamingToken(item.tokens);
	return { ...item, tokens };
}

function stabilizeLastStreamingToken(tokens: Token[]): Token[] {
	const lastToken = tokens.at(-1);
	if (!lastToken) return tokens;
	const stableToken = stabilizeStreamingToken(lastToken);
	return stableToken
		? [...tokens.slice(0, -1), stableToken]
		: tokens.slice(0, -1);
}

function stabilizeStreamingInlineToken(
	token: Tokens.Paragraph | Tokens.Heading | Tokens.Text,
): Token | undefined {
	// `raw` includes block syntax for headings (`# `), while `text` is exactly the
	// inline source consumed by the token's child parser. Stabilizing `raw` would
	// accidentally render the heading marker inside <h1> when emphasis is open.
	const stableSource = stabilizeStreamingBlockPrefix(token.text);
	if (!stableSource) return undefined;
	if (stableSource === token.text) return token;
	return {
		...token,
		text: stableSource,
		tokens: marked.Lexer.lexInline(stableSource),
	};
}

function stabilizeStreamingBlockPrefix(source: string): string {
	// A line-start marker can still become a list marker on the next character.
	// Keep the candidate line invisible until marked can classify it, otherwise
	// `1` or `- ` appears as text and disappears when the list item is formed.
	let stable = source.replace(
		/(^|\n) {0,3}(?:(?:[-*_][ \t]*){1,2}|\+[ \t]*|\d+(?:[.)][ \t]*)?)$/u,
		"$1",
	);
	stable = stabilizeStreamingLink(stable);
	stable = stabilizeTrailingEscape(stable);
	return stabilizeStreamingDelimiters(stable);
}

function stabilizeStreamingLink(source: string): string {
	const replaceCandidate = (
		_match: string,
		imageMarker: string | undefined,
		label: string,
	): string => (imageMarker ? "" : label);
	// Incomplete labels and destinations are the only link forms that marked may
	// reinterpret retroactively. Show link labels as text, but never leak brackets,
	// destination URLs, or image alt text that the completed construct consumes.
	let stable = source.replace(/(!?)\[([^\]\n]*)\]\([^\n)]*$/u, replaceCandidate);
	stable = stable.replace(/(!?)\[([^\]\n]*)\]$/u, replaceCandidate);
	return stable.replace(/(!?)\[([^\]\n]*)$/u, replaceCandidate);
}

function stabilizeTrailingEscape(source: string): string {
	let slashCount = 0;
	for (
		let index = source.length - 1;
		index >= 0 && source[index] === "\\";
		index -= 1
	) {
		slashCount += 1;
	}
	return slashCount % 2 === 1 ? source.slice(0, -1) : source;
}

function stabilizeStreamingCodeToken(token: Token): Token {
	if (token.type !== "code") return token;
	const opener = /^(?: {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/u.exec(token.raw);
	const marker = opener?.[1];
	if (!opener || !marker || !isOpenFencedCode(token.raw)) return token;

	// Marked exposes one or two leading closing-fence characters as code text,
	// then consumes them when the full fence arrives. Hide only such a partial
	// fence at the start of the current line so visible code never moves backwards.
	const bodySource = token.raw.slice(opener[0].length);
	let stableText = token.text;
	if (bodySource.endsWith("\n") && stableText.endsWith("\n")) {
		stableText = stableText.slice(0, -1);
	}
	const partialFence = new RegExp(
		`(?:^|\\n) {0,3}${marker[0]}{1,${marker.length - 1}}$`,
		"u",
	).exec(bodySource);
	if (partialFence) {
		stableText = token.text.slice(0, -partialFence[0].length);
	}
	return stableText === token.text ? token : { ...token, text: stableText };
}

/**
 * Removes only unmatched inline Markdown delimiters from the active token.
 *
 * A delimiter that is visible as plain text in one frame and consumed as syntax
 * in the next makes characters appear to move backwards. Matched runs remain in
 * the source so marked can render emphasis/code immediately; unmatched runs are
 * held invisible until either a mate arrives or the token settles, at which point
 * the authoritative Markdown pass restores any genuinely literal punctuation.
 */
function stabilizeStreamingDelimiters(source: string): string {
	let stable = maskUnmatchedRuns(source, "`");
	stable = maskUnmatchedRuns(stable, "*");
	stable = maskUnmatchedRuns(stable, "_");
	stable = maskUnmatchedRuns(stable, "~");
	return stable;
}

interface DelimiterRun {
	start: number;
	end: number;
	length: number;
	canOpen: boolean;
	canClose: boolean;
	matched: boolean;
}

function maskUnmatchedRuns(
	source: string,
	marker: "`" | "*" | "_" | "~",
	minimumLength = 1,
): string {
	const runs: DelimiterRun[] = [];
	for (let index = 0; index < source.length; ) {
		if (source[index] !== marker || isEscapedAt(source, index)) {
			index += 1;
			continue;
		}
		let end = index + 1;
		while (source[end] === marker) end += 1;
		const length = end - index;
		if (length < minimumLength) {
			index = end;
			continue;
		}
		const flanking =
			marker === "`"
				? { canOpen: true, canClose: true }
				: delimiterFlanking(source, index, end, marker);
		runs.push({
			start: index,
			end,
			length,
			canOpen: flanking.canOpen,
			canClose: flanking.canClose,
			matched: false,
		});
		index = end;
	}

	const openRuns: number[] = [];
	for (let index = 0; index < runs.length; index += 1) {
		const run = runs[index];
		if (!run) continue;
		let openerPosition = -1;
		if (run.canClose) {
			for (
				let stackIndex = openRuns.length - 1;
				stackIndex >= 0;
				stackIndex -= 1
			) {
				const opener = runs[openRuns[stackIndex] ?? -1];
				if (opener?.length === run.length) {
					openerPosition = stackIndex;
					break;
				}
			}
		}
		if (openerPosition >= 0) {
			const openerIndex = openRuns[openerPosition];
			const opener = openerIndex === undefined ? undefined : runs[openerIndex];
			if (opener) opener.matched = true;
			run.matched = true;
			openRuns.splice(openerPosition, 1);
			continue;
		}
		if (run.canOpen) openRuns.push(index);
	}

	if (
		runs.every(
			(run) =>
				run.matched || (!run.canOpen && !run.canClose && run.end < source.length),
		)
	) {
		return source;
	}
	const hidden = new Set<number>();
	for (const run of runs) {
		if (
			run.matched ||
			(!run.canOpen && !run.canClose && run.end < source.length)
		) {
			continue;
		}
		for (let index = run.start; index < run.end; index += 1) hidden.add(index);
	}
	let result = "";
	for (let index = 0; index < source.length; index += 1) {
		if (!hidden.has(index)) result += source[index];
	}
	return result;
}

function delimiterFlanking(
	source: string,
	start: number,
	end: number,
	marker: "*" | "_" | "~",
): { canOpen: boolean; canClose: boolean } {
	const previous = start > 0 ? (source[start - 1] ?? "") : "";
	const next = end < source.length ? (source[end] ?? "") : "";
	const previousWhitespace = previous === "" || /\s/u.test(previous);
	const nextWhitespace = next === "" || /\s/u.test(next);
	const previousPunctuation = previous !== "" && /[\p{P}\p{S}]/u.test(previous);
	const nextPunctuation = next !== "" && /[\p{P}\p{S}]/u.test(next);
	const leftFlanking =
		!nextWhitespace &&
		(!nextPunctuation || previousWhitespace || previousPunctuation);
	const rightFlanking =
		!previousWhitespace &&
		(!previousPunctuation || nextWhitespace || nextPunctuation);
	if (marker !== "_") {
		return { canOpen: leftFlanking, canClose: rightFlanking };
	}
	return {
		canOpen: leftFlanking && (!rightFlanking || previousPunctuation),
		canClose: rightFlanking && (!leftFlanking || nextPunctuation),
	};
}

function isEscapedAt(source: string, index: number): boolean {
	let slashCount = 0;
	for (
		let cursor = index - 1;
		cursor >= 0 && source[cursor] === "\\";
		cursor -= 1
	) {
		slashCount += 1;
	}
	return slashCount % 2 === 1;
}

function tokenAppendMode(token: Token): StreamingMarkdownAppendMode {
	if (tokenHasPendingStreamingSyntax(token)) return "none";
	if (token.type === "code") {
		// Marked omits the final source newline from the rendered code text. If a
		// frame stops exactly there, reparse once when the next characters arrive so
		// two source lines cannot be concatenated in the DOM. After the next visible
		// character, arbitrary code suffixes append directly until a fence marker.
		return isOpenFencedCode(token.raw) &&
			token.raw.includes("\n") &&
			!token.raw.endsWith("\n")
			? "code"
			: "none";
	}
	if (token.raw.endsWith("\n")) return "none";
	if (token.type === "paragraph" || token.type === "heading") {
		return inlineTokensEndInPlainText(token.tokens) ? "plain" : "none";
	}
	if (token.type === "blockquote") {
		const lastNested = token.tokens?.at(-1);
		return lastNested ? tokenAppendMode(lastNested) : "none";
	}
	if (token.type === "list") {
		const lastNested = token.items.at(-1)?.tokens.at(-1);
		return lastNested ? tokenAppendMode(lastNested) : "none";
	}
	if (token.type === "text") {
		return token.tokens
			? inlineTokensEndInPlainText(token.tokens)
				? "plain"
				: "none"
			: "plain";
	}
	return "none";
}

function tokenHasPendingStreamingSyntax(token: Token): boolean {
	if (
		token.type === "heading" &&
		isPendingSetextHeading(token as Tokens.Heading)
	) {
		return true;
	}
	if (token.type === "list") {
		const list = token as Tokens.List;
		const lastNested = list.items.at(-1)?.tokens.at(-1);
		return lastNested ? tokenHasPendingStreamingSyntax(lastNested) : false;
	}
	if (token.type === "blockquote") {
		const blockquote = token as Tokens.Blockquote;
		const lastNested = blockquote.tokens.at(-1);
		return lastNested ? tokenHasPendingStreamingSyntax(lastNested) : false;
	}
	return hasPendingStreamingSyntax(token.raw);
}

function hasPendingStreamingSyntax(source: string): boolean {
	if (
		/(?:^|\n) {0,3}(?:[-*_]+[ \t]*|\+[ \t]*|\d+(?:[.)][ \t]*)?)$/u.test(source)
	) {
		return true;
	}
	if (
		/!?\[[^\]\n]*(?:\]|\]\([^\n)]*)?$/u.test(source) ||
		hasOddTrailingBackslash(source)
	) {
		return true;
	}
	return /(?:`+|\*+|_+|~+)$/u.test(source);
}

function hasOddTrailingBackslash(source: string): boolean {
	let slashCount = 0;
	for (
		let index = source.length - 1;
		index >= 0 && source[index] === "\\";
		index -= 1
	) {
		slashCount += 1;
	}
	return slashCount % 2 === 1;
}

function inlineTokensEndInPlainText(tokens: Token[] | undefined): boolean {
	const lastToken = tokens?.at(-1);
	if (!lastToken || lastToken.type !== "text") return false;
	return lastToken.tokens ? inlineTokensEndInPlainText(lastToken.tokens) : true;
}

function isOpenFencedCode(raw: string): boolean {
	const opener = /^(?: {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/u.exec(raw);
	if (!opener) return false;
	const marker = opener[1];
	if (!marker) return false;
	const closingFence = new RegExp(
		`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)`,
		"mu",
	);
	return !closingFence.test(raw.slice(opener[0].length));
}

/**
 * Markdown to sanitized HTML.
 *
 * `highlight` is off by default: highlighting a streaming message would re-run
 * the highlighter on every delta. Streaming still gets full Markdown structure;
 * only syntax highlighting waits for the settled authoritative message.
 */
function markdown(text: string, highlight = false): string {
	highlightEnabled = highlight;
	try {
		return sanitizeMarkdown(marked.parse(text) as string);
	} finally {
		// Reset unconditionally: a throw must not leave highlighting armed for the
		// next, possibly streaming, pass.
		highlightEnabled = false;
	}
}

function markdownTokens(tokens: Token[]): string {
	highlightEnabled = false;
	try {
		return sanitizeMarkdown(marked.parser(tokens));
	} finally {
		highlightEnabled = false;
	}
}

function sanitizeMarkdown(html: string): string {
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		ADD_ATTR: ["target", "rel"],
	});
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
