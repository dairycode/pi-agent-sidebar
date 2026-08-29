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

/**
 * The append-only session entry returned by pi's `get_entries` command.
 * `id` and `parentId` are opaque pi-owned identities; the host must never
 * derive them from a transcript array index or message content.
 */
export interface PiSessionEntry extends JsonRecord {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface PiSessionEntries extends JsonRecord {
	entries: PiSessionEntry[];
	leafId: string | null;
}

export interface PiSessionTreeNode extends JsonRecord {
	entry: PiSessionEntry;
	children: PiSessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

export interface PiSessionTree extends JsonRecord {
	tree: PiSessionTreeNode[];
	leafId: string | null;
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
	entries: boolean;
	tree: boolean;
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
	firstActivityAt?: string;
	messageCount?: number;
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
	| { type: "setComposerText"; text: string };

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

const MAX_ACTION_ID_LENGTH = 128;
/** Mirrors the host-side entry-id ceiling in `rpcValidation`. */
const MAX_ENTRY_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 32 * 1024;
const MAX_SESSION_NAME_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 1_000_000;
const MAX_MENTION_QUERY_LENGTH = 512;
export const MAX_WORKSPACE_ENTRY_SUGGESTIONS = 200;
const MAX_PASTED_IMAGE_DATA_LENGTH = 16 * 1024 * 1024 + 16;
export const MAX_IMAGE_ATTACHMENT_COUNT = 4;
export const MAX_ATTACHMENT_COUNT = 20;
export const MAX_COMPOSER_REFERENCE_COUNT = 10;
/**
 * Per-image and per-batch ceilings, shared so the webview rejects an oversized
 * paste with the same limits the host enforces. Independent copies in the
 * webview and the host could drift apart silently.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

export function parseWebviewMessage(
	value: unknown,
): WebviewToHostMessage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const message = value as Record<string, unknown>;
	const type = boundedString(message.type, 64);
	if (!type) return;

	if (
		[
			"ready",
			"listSessions",
			"listCommands",
			"pickAttachments",
			"showLogs",
		].includes(type)
	) {
		return { type } as WebviewToHostMessage;
	}
	if (type === "composerFocused") {
		const requestId = nonNegativeInteger(message.requestId);
		return requestId === undefined ? undefined : { type, requestId };
	}
	if (type === "listWorkspaceFiles") {
		const requestId = nonNegativeInteger(message.requestId);
		const query = boundedString(message.query, MAX_MENTION_QUERY_LENGTH, true);
		return requestId === undefined || query === undefined
			? undefined
			: { type, requestId, query };
	}
	if (
		[
			"abort",
			"newSession",
			"cloneSession",
			"listForkCandidates",
			"compact",
			"restart",
		].includes(type)
	) {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		return actionId ? ({ type, actionId } as WebviewToHostMessage) : undefined;
	}
	if (type === "submit") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const text = boundedString(message.text, MAX_MESSAGE_LENGTH, true);
		const attachmentIds = boundedStringArray(
			message.attachmentIds,
			MAX_ATTACHMENT_COUNT,
			128,
		);
		const references = parseReferenceIdentities(message.references);
		if (!actionId || text === undefined || !attachmentIds || !references)
			return;
		return { type, actionId, text, attachmentIds, references };
	}
	if (type === "forkSession") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const entryId = boundedString(message.entryId, MAX_ENTRY_ID_LENGTH);
		return actionId && entryId ? { type, actionId, entryId } : undefined;
	}
	if (type === "switchSession" || type === "deleteSession") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const sessionPath = boundedString(message.path, MAX_PATH_LENGTH);
		return actionId && sessionPath
			? { type, actionId, path: sessionPath }
			: undefined;
	}
	if (type === "setModel") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const provider = boundedString(message.provider, 512);
		const modelId = boundedString(message.modelId, 512);
		return actionId && provider && modelId
			? { type, actionId, provider, modelId }
			: undefined;
	}
	if (type === "setThinking") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const level = boundedString(message.level, 128);
		return actionId && level ? { type, actionId, level } : undefined;
	}
	if (type === "renameSession") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const name = boundedString(message.name, MAX_SESSION_NAME_LENGTH);
		return actionId && name ? { type, actionId, name } : undefined;
	}
	if (type === "pasteImages") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const images = parsePastedImages(message.images);
		return actionId && images ? { type, actionId, images } : undefined;
	}
	if (type === "addResources") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const resources = boundedStringArray(
			message.resources,
			MAX_COMPOSER_REFERENCE_COUNT,
			MAX_PATH_LENGTH,
		);
		return actionId && resources && resources.length > 0
			? { type, actionId, resources }
			: undefined;
	}
	if (type === "removeAttachment" || type === "openComposerReference") {
		const id = boundedString(message.id, 128);
		return id ? { type, id } : undefined;
	}
	if (type === "removeComposerReference") {
		const id = boundedString(message.id, 128);
		const revision = nonNegativeInteger(message.revision);
		return id && revision !== undefined ? { type, id, revision } : undefined;
	}
	if (type === "openExternal") {
		const href = boundedString(message.href, 8 * 1024);
		return href ? { type, href } : undefined;
	}
	if (type === "openResource") {
		const uri = boundedString(message.uri, MAX_PATH_LENGTH);
		if (!uri) return undefined;
		const line = nonNegativeInteger(message.line);
		return line === undefined ? { type, uri } : { type, uri, line };
	}
	if (type === "openWorkspacePath") {
		const workspacePath = boundedString(message.path, MAX_PATH_LENGTH);
		if (!workspacePath) return undefined;
		const line = nonNegativeInteger(message.line);
		return line === undefined
			? { type, path: workspacePath }
			: { type, path: workspacePath, line };
	}
	return;
}

function parseReferenceIdentities(value: unknown):
	| Array<{
			id: string;
			revision: number;
			start: number;
			end: number;
	  }>
	| undefined {
	if (!Array.isArray(value) || value.length > MAX_COMPOSER_REFERENCE_COUNT)
		return;
	const references = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return;
		const candidate = item as Record<string, unknown>;
		const id = boundedString(candidate.id, 128);
		const revision = nonNegativeInteger(candidate.revision);
		const start = nonNegativeInteger(candidate.start);
		const end = nonNegativeInteger(candidate.end);
		if (
			!id ||
			revision === undefined ||
			start === undefined ||
			end === undefined ||
			end <= start
		) {
			return;
		}
		references.push({ id, revision, start, end });
	}
	return references;
}

function parsePastedImages(value: unknown): PastedImage[] | undefined {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAX_IMAGE_ATTACHMENT_COUNT
	)
		return;
	const images: PastedImage[] = [];
	let totalDataLength = 0;
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return;
		const candidate = item as Record<string, unknown>;
		const name = boundedString(candidate.name, 512, true);
		const mimeType = boundedString(candidate.mimeType, 128);
		const data = boundedString(
			candidate.data,
			MAX_PASTED_IMAGE_DATA_LENGTH,
			true,
		);
		if (name === undefined || !mimeType || data === undefined) return;
		totalDataLength += data.length;
		if (totalDataLength > MAX_PASTED_IMAGE_DATA_LENGTH) return;
		images.push({ name, mimeType, data });
	}
	return images;
}

function boundedString(
	value: unknown,
	maxLength: number,
	allowEmpty = false,
): string | undefined {
	if (typeof value !== "string" || value.length > maxLength) return;
	if (!allowEmpty && value.length === 0) return;
	return value;
}

function boundedStringArray(
	value: unknown,
	maxItems: number,
	maxLength: number,
): string[] | undefined {
	if (!Array.isArray(value) || value.length > maxItems) return;
	const values: string[] = [];
	for (const item of value) {
		const parsed = boundedString(item, maxLength);
		if (!parsed) return;
		values.push(parsed);
	}
	return values;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}
