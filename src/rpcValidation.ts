import type {
	JsonRecord,
	PiCommand,
	PiContentBlock,
	PiMessage,
	PiModel,
	PiState,
	PiStats,
} from "./shared/protocol.js";

const MAX_MESSAGES = 5_000;
const MAX_CONTENT_BLOCKS = 10_000;
const MAX_MODELS = 1_000;
const MAX_COMMANDS = 2_000;
const MAX_COMMAND_NAME_LENGTH = 512;
const MAX_COMMAND_DESCRIPTION_LENGTH = 8 * 1024;
const MAX_THINKING_LEVELS = 100;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_IMAGE_DATA_LENGTH = 16 * 1024 * 1024 + 16;

export class ProtocolValidationError extends Error {}

export function parsePiState(value: unknown): PiState {
	const state = record(value, "state");
	optionalString(state.sessionFile, "state.sessionFile", 32 * 1024);
	optionalString(state.sessionId, "state.sessionId", 512);
	optionalString(state.sessionName, "state.sessionName", 8 * 1024);
	optionalString(state.thinkingLevel, "state.thinkingLevel", 128);
	optionalBoolean(state.isStreaming, "state.isStreaming");
	optionalBoolean(state.isCompacting, "state.isCompacting");
	optionalNumber(state.messageCount, "state.messageCount");
	optionalNumber(state.pendingMessageCount, "state.pendingMessageCount");
	if (state.model !== undefined && state.model !== null)
		parsePiModel(state.model);
	return state as PiState;
}

export function parseMessagesResponse(value: unknown): PiMessage[] {
	const response = record(value, "messages response");
	return array(response.messages, "messages", MAX_MESSAGES).map(
		(message, index) => parsePiMessage(message, `messages[${index}]`),
	);
}

export function parseModelsResponse(value: unknown): PiModel[] {
	const response = record(value, "models response");
	return array(response.models, "models", MAX_MODELS).map((model) =>
		parsePiModel(model),
	);
}

export function parseThinkingLevelsResponse(value: unknown): string[] {
	const response = record(value, "thinking-levels response");
	return array(response.levels, "levels", MAX_THINKING_LEVELS).map(
		(level, index) => string(level, `levels[${index}]`, 128),
	);
}

/**
 * Extracts the command fields the sidebar renders.
 *
 * Rows missing a usable `name` are dropped rather than throwing: a single
 * malformed entry from an extension should not blank the entire command list.
 * Unknown `source`/`location` values pass through untouched so a newly added
 * pi command kind only loses its grouping header.
 */
export function parseCommandsResponse(value: unknown): PiCommand[] {
	const response = record(value, "commands response");
	const commands: PiCommand[] = [];
	for (const [index, entry] of array(
		response.commands,
		"commands",
		MAX_COMMANDS,
	).entries()) {
		const command = record(entry, `commands[${index}]`);
		const name = command.name;
		if (
			typeof name !== "string" ||
			name.length === 0 ||
			name.length > MAX_COMMAND_NAME_LENGTH
		) {
			continue;
		}
		const parsed: PiCommand = { ...command, name };
		parsed.description = optionalString(
			command.description,
			`commands[${index}].description`,
			MAX_COMMAND_DESCRIPTION_LENGTH,
		);
		parsed.source = optionalString(
			command.source,
			`commands[${index}].source`,
			128,
		);
		parsed.location = optionalString(
			command.location,
			`commands[${index}].location`,
			128,
		);
		parsed.path = optionalString(
			command.path,
			`commands[${index}].path`,
			32 * 1024,
		);
		commands.push(parsed);
	}
	return commands;
}

export function parsePiStats(value: unknown): PiStats {
	const stats = record(value, "session stats");
	optionalNumber(stats.cost, "stats.cost");
	optionalNumber(stats.totalMessages, "stats.totalMessages");
	optionalNumber(stats.toolCalls, "stats.toolCalls");
	if (stats.contextUsage !== undefined) {
		const usage = record(stats.contextUsage, "stats.contextUsage");
		optionalNullableNumber(usage.tokens, "stats.contextUsage.tokens");
		optionalNumber(usage.contextWindow, "stats.contextUsage.contextWindow");
		optionalNullableNumber(usage.percent, "stats.contextUsage.percent");
	}
	if (stats.tokens !== undefined) {
		const tokens = record(stats.tokens, "stats.tokens");
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
			optionalNumber(tokens[key], `stats.tokens.${key}`);
		}
	}
	return stats as PiStats;
}

export function parseSessionChangeResult(value: unknown): {
	cancelled?: boolean;
} {
	if (value === undefined || value === null) return {};
	const result = record(value, "session change response");
	optionalBoolean(result.cancelled, "session change response.cancelled");
	return result as { cancelled?: boolean };
}

export function validateRpcEvent(event: JsonRecord): JsonRecord {
	const type = optionalString(event.type, "event.type", 128);
	if (!type) throw new ProtocolValidationError("Pi event is missing a type.");
	if (["message_start", "message_update", "message_end"].includes(type)) {
		parsePiMessage(event.message, `${type}.message`);
	}
	if (type.startsWith("tool_execution_")) {
		optionalString(event.toolCallId, `${type}.toolCallId`, 512);
		optionalString(event.toolName, `${type}.toolName`, 512);
	}
	return event;
}

function parsePiMessage(value: unknown, label = "message"): PiMessage {
	const message = record(value, label);
	string(message.role, `${label}.role`, 128);
	optionalString(message.toolCallId, `${label}.toolCallId`, 512);
	optionalString(message.toolName, `${label}.toolName`, 512);
	optionalString(
		message.errorMessage,
		`${label}.errorMessage`,
		MAX_TEXT_LENGTH,
	);
	optionalString(message.command, `${label}.command`, MAX_TEXT_LENGTH);
	optionalString(message.output, `${label}.output`, MAX_TEXT_LENGTH);
	optionalString(message.summary, `${label}.summary`, MAX_TEXT_LENGTH);
	if (message.content !== undefined) {
		if (typeof message.content === "string") {
			string(message.content, `${label}.content`, MAX_TEXT_LENGTH);
		} else {
			for (const [index, block] of array(
				message.content,
				`${label}.content`,
				MAX_CONTENT_BLOCKS,
			).entries()) {
				parseContentBlock(block, `${label}.content[${index}]`);
			}
		}
	}
	return message as PiMessage;
}

function parseContentBlock(value: unknown, label: string): PiContentBlock {
	const block = record(value, label);
	string(block.type, `${label}.type`, 128);
	optionalString(block.text, `${label}.text`, MAX_TEXT_LENGTH);
	optionalString(block.thinking, `${label}.thinking`, MAX_TEXT_LENGTH);
	optionalString(block.data, `${label}.data`, MAX_IMAGE_DATA_LENGTH);
	optionalString(block.mimeType, `${label}.mimeType`, 128);
	optionalString(block.id, `${label}.id`, 512);
	optionalString(block.name, `${label}.name`, 512);
	if (block.arguments !== undefined)
		record(block.arguments, `${label}.arguments`);
	return block as PiContentBlock;
}

function parsePiModel(value: unknown): PiModel {
	const model = record(value, "model");
	string(model.id, "model.id", 512);
	string(model.name, "model.name", 512);
	string(model.provider, "model.provider", 512);
	optionalBoolean(model.reasoning, "model.reasoning");
	optionalNumber(model.contextWindow, "model.contextWindow");
	return model as PiModel;
}

function record(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProtocolValidationError(`${label} must be an object.`);
	}
	return value as JsonRecord;
}

function array(value: unknown, label: string, maxLength: number): unknown[] {
	if (!Array.isArray(value)) {
		throw new ProtocolValidationError(`${label} must be an array.`);
	}
	if (value.length > maxLength) {
		throw new ProtocolValidationError(
			`${label} exceeds the ${maxLength}-item limit.`,
		);
	}
	return value;
}

function string(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string") {
		throw new ProtocolValidationError(`${label} must be a string.`);
	}
	if (value.length > maxLength) {
		throw new ProtocolValidationError(`${label} is too large.`);
	}
	return value;
}

function optionalString(
	value: unknown,
	label: string,
	maxLength: number,
): string | undefined {
	return value === undefined ? undefined : string(value, label, maxLength);
}

function optionalBoolean(value: unknown, label: string): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new ProtocolValidationError(`${label} must be a boolean.`);
	}
}

function optionalNumber(value: unknown, label: string): void {
	if (
		value !== undefined &&
		(typeof value !== "number" || !Number.isFinite(value))
	) {
		throw new ProtocolValidationError(`${label} must be a finite number.`);
	}
}

function optionalNullableNumber(value: unknown, label: string): void {
	if (value !== null) optionalNumber(value, label);
}
