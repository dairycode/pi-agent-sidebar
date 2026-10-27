export type JsonRecord = Record<string, unknown>;

export interface PiContentBlock extends JsonRecord {
	type: string;
	text?: string;
	thinking?: string;
	data?: string;
	mimeType?: string;
	id?: string;
	name?: string;
	arguments?: JsonRecord;
}

export interface PiMessage extends JsonRecord {
	role: string;
	content?: string | PiContentBlock[];
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	errorMessage?: string;
	command?: string;
	output?: string;
	summary?: string;
	display?: boolean;
}

/** A user message that pi explicitly says can be used as a fork cursor. */
export interface ForkCandidate extends JsonRecord {
	entryId: string;
	text: string;
	timestamp?: number;
}

/**
 * Capabilities are response-backed and may be downgraded after an RPC error.
 *
 * Deliberately not a `JsonRecord`: an index signature would widen
 * `keyof PiCapabilities` to `string` and lose the per-flag typing the host
 * relies on when recording a capability failure.
 */
export interface PiCapabilities {
	clone: boolean;
	fork: boolean;
	forkMessages: boolean;
}

export interface PiTimeContext {
	locale: string;
	hostNowMs: number;
}

export interface PiSessionChangeResult extends JsonRecord {
	cancelled?: boolean;
	text?: string;
	sessionId?: string;
	sessionFile?: string;
}

export interface PiModel extends JsonRecord {
	id: string;
	name: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
}

/**
 * A slash command reported by pi's `get_commands`.
 *
 * `source` and `location` stay open-ended on purpose: pi may add new kinds, and
 * an unknown value should only cost the row its grouping header rather than
 * failing validation and blanking the whole list.
 */
export interface PiCommand extends JsonRecord {
	name: string;
	description?: string;
	source?: "extension" | "prompt" | "skill" | (string & {});
	location?: "user" | "project" | "path" | (string & {});
	path?: string;
}

/**
 * One entry offered by the `@` mention popup at the level currently browsed.
 *
 * The popup shows a single directory level at a time, so an entry is either a
 * file that can be referenced or a directory the user descends into.
 * `displayPath` is the workspace-relative path from the root, which doubles as
 * the text the composer writes when descending.
 *
 * Files always carry a canonical `uri`. A directory row normally navigates to
 * the next level; a `current` directory row carries its canonical `uri` and can
 * be committed as a composer reference when the user types a complete path
 * ending in `/`.
 */
export interface WorkspaceFileSuggestion {
	kind: "file";
	displayPath: string;
	uri: string;
}

export interface WorkspaceDirectorySuggestion {
	kind: "directory";
	displayPath: string;
	uri?: string;
	current?: true;
}

export type WorkspaceEntrySuggestion =
	| WorkspaceFileSuggestion
	| WorkspaceDirectorySuggestion;

export type WorkspaceReferenceSuggestion =
	| WorkspaceFileSuggestion
	| (WorkspaceDirectorySuggestion & { uri: string; current: true });

export interface PiState extends JsonRecord {
	model?: PiModel | null;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount?: number;
	pendingMessageCount?: number;
	contextPercent?: number | null;
}

export interface PiStats extends JsonRecord {
	totalMessages?: number;
	userMessages?: number;
	assistantMessages?: number;
	toolResults?: number;
	toolCalls?: number;
	cost?: number;
	contextUsage?: {
		tokens?: number | null;
		contextWindow?: number;
		percent?: number | null;
	};
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

export interface AttachmentRef {
	id: string;
	path: string;
	label: string;
	kind: "file" | "image";
}

interface ComposerReferenceBase {
	id: string;
	revision: number;
	marker: string;
	displayPath: string;
}

export interface FileComposerReference extends ComposerReferenceBase {
	kind: "file";
}

export interface DirectoryComposerReference extends ComposerReferenceBase {
	kind: "directory";
}

export interface SelectionComposerReference extends ComposerReferenceBase {
	kind: "selection";
	startLine: number;
	endLine: number;
}

export type ComposerReference =
	| FileComposerReference
	| DirectoryComposerReference
	| SelectionComposerReference;

export interface PastedImage {
	name: string;
	mimeType: string;
	data: string;
}

export interface SessionSummary {
	path: string;
	title: string;
	excerpt: string;
	createdAt: string;
	lastActivityAt?: string;
	active: boolean;
}

interface ActionResult {
	type: "actionResult";
	actionId: string;
	ok: boolean;
	cancelled?: boolean;
	error?: string;
}

export type HostToWebviewMessage =
	| {
			type: "bootstrap";
			phase: "starting" | "no-workspace";
			workspaceName?: string;
			detail?: string;
	  }
	| {
			type: "snapshot";
			state: PiState;
			messages: PiMessage[];
			/**
			 * How many older messages the host left out of `messages`.
			 *
			 * A snapshot carries only the newest messages; the webview reports this
			 * number together with the messages it drops past its own render cap, so the
			 * reader still learns how much history is hidden.
			 */
			omittedMessageCount?: number;
			/**
			 * Text of the session's first user message, when `messages` no longer carries
			 * it.
			 *
			 * The session title is derived from that prompt and a windowed snapshot has
			 * dropped it, so the host reads it from the full list it still holds. Left out
			 * when the window reaches the head, where the webview reads it from `messages`
			 * itself. Never a transcript entry — it exists for the title.
			 */
			titleSeed?: string;
			stats?: PiStats;
			models: PiModel[];
			thinkingLevels: string[];
			commands: PiCommand[];
			workspaceName: string;
			capabilities?: PiCapabilities;
			timeContext?: PiTimeContext;
	  }
	| { type: "rpcEvent"; event: JsonRecord }
	| { type: "capabilities"; capabilities: PiCapabilities }
	| ActionResult
	| { type: "sessionList"; sessions: SessionSummary[] }
	/**
	 * The prompts the active session can fork from, in transcript order.
	 *
	 * Sent in reply to `listForkCandidates`. An empty array means this session has
	 * no earlier prompt, which the picker reports in place rather than as an error.
	 */
	| { type: "forkCandidates"; candidates: ForkCandidate[] }
	| { type: "commandList"; commands: PiCommand[] }
	| {
			type: "workspaceFileList";
			requestId: number;
			query: string;
			entries: WorkspaceEntrySuggestion[];
	  }
	| {
			type: "mediaResolved";
			requestId: number;
			resolved: Array<{ source: string; uri: string }>;
	  }
	| { type: "attachments"; attachments: AttachmentRef[] }
	| {
			type: "composerReferences";
			references: ComposerReference[];
			focusRequestId?: number;
	  }
	| {
			type: "connection";
			phase: "starting" | "ready" | "disconnected" | "error";
			detail?: string;
	  }
	/**
	 * A command failed, but the session is fine.
	 *
	 * Distinct from `connection: error`, which is the banner's fatal state: it marks
	 * the in-flight reply aborted, disables sending, and leaves Restart as the only
	 * button. A refused `mailto:` link, a path outside the workspace, or a missing
	 * workspace folder all used to travel on that channel and took the whole
	 * sidebar down with them.
	 */
	| { type: "notice"; kind: "info" | "error"; detail: string }
	| { type: "setComposerText"; text: string };

/**
 * How a submitted prompt is delivered relative to a turn pi is already running.
 *
 * Forwarded as pi's `streamingBehavior`. Omitting the field keeps the historical
 * behavior: the host steers only when it knows pi is streaming. pi ignores the
 * field when idle, so a forced mode degrades to a plain prompt.
 */
export type SubmitDelivery = "steer" | "followUp";

export type WebviewToHostMessage =
	| { type: "ready" }
	| { type: "composerFocused"; requestId: number }
	| {
			type: "submit";
			actionId: string;
			text: string;
			attachmentIds: string[];
			references: Array<{
				id: string;
				revision: number;
				start: number;
				end: number;
			}>;
			/** Omitted lets the host decide from the streaming state it knows. */
			delivery?: SubmitDelivery;
	  }
	| { type: "abort"; actionId: string }
	| { type: "newSession"; actionId: string }
	| { type: "cloneSession"; actionId: string }
	/**
	 * Asks the host for the prompts this session can fork from.
	 *
	 * Carries an `actionId` so an RPC failure surfaces as an error on the request
	 * itself, instead of an empty picker with nothing to explain it.
	 */
	| { type: "listForkCandidates"; actionId: string }
	/**
	 * `entryId` is chosen in the webview, because the picker is a webview list: the
	 * host only executes a decision already made. It is re-validated against the
	 * live session inside the mutation queue, since the list was built earlier and
	 * the session may have moved on.
	 */
	| { type: "forkSession"; actionId: string; entryId: string }
	| { type: "switchSession"; actionId: string; path: string }
	| { type: "deleteSession"; actionId: string; path: string }
	| { type: "renameSession"; actionId: string; name: string }
	| { type: "setModel"; actionId: string; provider: string; modelId: string }
	| { type: "setThinking"; actionId: string; level: string }
	| { type: "compact"; actionId: string }
	| { type: "restart"; actionId: string }
	| { type: "listSessions" }
	| { type: "listCommands" }
	| { type: "listWorkspaceFiles"; requestId: number; query: string }
	/**
	 * Asks the host to turn local image paths from the transcript into URIs the
	 * webview may load.
	 *
	 * Only the host can call `asWebviewUri`, and a webview relative path resolves
	 * against its own origin rather than the file system, so a Markdown image
	 * cannot be rendered without this round trip. Batched because one rendered
	 * message can hold several images and each request costs a message.
	 */
	| { type: "resolveMedia"; requestId: number; sources: string[] }
	| { type: "pickAttachments" }
	| { type: "addResources"; actionId: string; resources: string[] }
	| { type: "pasteImages"; actionId: string; images: PastedImage[] }
	| { type: "removeAttachment"; id: string }
	| { type: "removeComposerReference"; id: string; revision: number }
	| { type: "openComposerReference"; id: string }
	| { type: "openExternal"; href: string }
	| { type: "openResource"; uri: string; line?: number }
	| { type: "openWorkspacePath"; path: string; line?: number }
	| { type: "showLogs" };

/**
 * Every `WebviewToHostMessage` type, as a runtime list.
 *
 * The parser below and the host's dispatch switch are both keyed on strings, so
 * TypeScript cannot check that they stay in step with the union. This list is
 * the single source both sides are measured against:
 *
 * - the assertions below make an entry missing from this list a compile error;
 * - `test/unit/shared/protocol.test.mjs` walks this list and proves the parser
 *   accepts a valid message of every one of them.
 *
 * Order is the order of the union above, which is the order a reader checks
 * against it.
 */
export const WEBVIEW_REQUEST_TYPES = [
	"ready",
	"composerFocused",
	"submit",
	"abort",
	"newSession",
	"cloneSession",
	"listForkCandidates",
	"forkSession",
	"switchSession",
	"deleteSession",
	"renameSession",
	"setModel",
	"setThinking",
	"compact",
	"restart",
	"listSessions",
	"listCommands",
	"listWorkspaceFiles",
	"resolveMedia",
	"pickAttachments",
	"addResources",
	"pasteImages",
	"removeAttachment",
	"removeComposerReference",
	"openComposerReference",
	"openExternal",
	"openResource",
	"openWorkspacePath",
	"showLogs",
] as const satisfies readonly WebviewToHostMessage["type"][];

type WebviewRequestType = (typeof WEBVIEW_REQUEST_TYPES)[number];

/**
 * Variants of `WebviewToHostMessage` the list above does not name. `never` when
 * the two agree.
 */
type UnlistedRequestType = Exclude<
	WebviewToHostMessage["type"],
	WebviewRequestType
>;

/**
 * Compile-time coverage check for `WEBVIEW_REQUEST_TYPES`.
 *
 * The constraint on the parameter is the assertion: `UnlistedRequestType` is
 * `never` exactly when every variant of the union appears in the list, so a
 * variant missing from it turns the argument into a string literal, which
 * `never` refuses. Nothing happens at runtime — the call exists so the check is
 * a live statement rather than an alias nobody reads.
 */
function assertEveryRequestTypeIsListed(missing: UnlistedRequestType): void {
	void missing;
}

assertEveryRequestTypeIsListed(undefined as UnlistedRequestType);

export const MAX_PATH_LENGTH = 32 * 1024;
export const MAX_WORKSPACE_ENTRY_SUGGESTIONS = 200;
export const MAX_IMAGE_ATTACHMENT_COUNT = 4;
/** Per-request ceiling for one transcript image batch; the webview chunks past it. */
export const MAX_RESOLVE_MEDIA_SOURCES = 20;
export const MAX_ATTACHMENT_COUNT = 20;
export const MAX_COMPOSER_REFERENCE_COUNT = 10;
/**
 * Per-image and per-batch ceilings, shared so the webview rejects an oversized
 * paste with the same limits the host enforces. Independent copies in the
 * webview and the host could drift apart silently.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

export { parseWebviewMessage } from "./protocolParser.js";
