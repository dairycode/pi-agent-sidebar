/// <reference types="node" />

import { open, readFile, readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PiContentBlock, SessionSummary } from "../../shared/protocol.js";

const MAX_SESSION_FILES = 40;
const MAX_FULL_READ_BYTES = 2 * 1024 * 1024;
const HEAD_READ_BYTES = 1024 * 1024;
const TAIL_READ_BYTES = 256 * 1024;

interface SessionHeader {
	type: "session";
	cwd?: string;
	timestamp?: string;
}

interface SessionTimestamp {
	value: string;
	epochMs: number;
}

interface SessionLines {
	lines: string[];
	complete: boolean;
}

function sessionDirectoryName(cwd: string): string {
	// Must match pi's getDefaultSessionDirPath character for character
	// (dist/core/session-manager.js): strip exactly one leading separator and
	// replace each separator individually. Collapsing runs turns the Windows
	// drive prefix C:\Users\... into --C-Users-...-- while pi writes
	// --C--Users-...-- so the session history silently comes up empty.
	const normalized = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return `--${normalized}--`;
}

export function resolveSessionDirectory(
	cwd: string,
	configuredValue?: string,
	environmentValue = process.env.PI_CODING_AGENT_SESSION_DIR,
): string | undefined {
	const value = configuredValue?.trim() || environmentValue?.trim();
	return value ? path.resolve(cwd, value) : undefined;
}

function resolveContainedPath(
	parent: string,
	child: string,
): string | undefined {
	// pi-lens-ignore: ts-path-traversal -- The parent is an intentional storage root and is checked again below., ts-path-traversal
	const resolvedParent = path.resolve(parent);
	// pi-lens-ignore: ts-path-traversal -- basename plus the relative-path check prevents escaping the parent., ts-path-traversal
	const resolvedChild = path.resolve(resolvedParent, path.basename(child));
	const relative = path.relative(resolvedParent, resolvedChild);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return undefined;
	}
	return resolvedChild;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const text: string[] = [];
	for (const value of content) {
		if (!value || typeof value !== "object") continue;
		const block = value as PiContentBlock;
		if (block.type === "text" && typeof block.text === "string")
			text.push(block.text);
	}
	return text.join("\n");
}

function cleanExcerpt(text: string): string {
	return text
		.replace(/^<pi-context>[\s\S]*?<\/pi-context>\s*/u, "")
		.replace(/\s+/gu, " ")
		.trim();
}

async function readSessionLines(
	filePath: string,
	size: number,
): Promise<SessionLines> {
	if (size <= MAX_FULL_READ_BYTES) {
		const contents = await readFile(filePath, "utf8");
		return {
			lines: splitCompleteLines(contents, true, true),
			complete: true,
		};
	}

	const handle = await open(filePath, "r");
	try {
		const headLength = Math.min(size, HEAD_READ_BYTES);
		const tailLength = Math.min(Math.max(0, size - headLength), TAIL_READ_BYTES);
		const head = await readBytes(handle, headLength, 0);
		const tailOffset = Math.max(0, size - tailLength);
		const tail = await readBytes(handle, tailLength, tailOffset);
		let tailStartsAtLineBoundary = tailOffset === 0;
		if (tailOffset > 0) {
			const previous = await readBytes(handle, 1, tailOffset - 1);
			tailStartsAtLineBoundary = previous[0] === 0x0a;
		}
		return {
			lines: [
				...splitCompleteLines(head.toString("utf8"), true, head.at(-1) === 0x0a),
				...splitCompleteLines(
					tail.toString("utf8"),
					tailStartsAtLineBoundary,
					true,
				),
			],
			complete: false,
		};
	} finally {
		await handle.close();
	}
}

async function readBytes(
	handle: Awaited<ReturnType<typeof open>>,
	length: number,
	position: number,
): Promise<Buffer> {
	if (length <= 0) return Buffer.alloc(0);
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const result = await handle.read(
			buffer,
			offset,
			length - offset,
			position + offset,
		);
		if (result.bytesRead === 0) break;
		offset += result.bytesRead;
	}
	return buffer.subarray(0, offset);
}

function splitCompleteLines(
	text: string,
	firstLineComplete: boolean,
	lastLineComplete: boolean,
): string[] {
	let lines = text.split("\n");
	if (!firstLineComplete) lines = lines.slice(1);
	if (!lastLineComplete) lines = lines.slice(0, -1);
	return lines
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
		.filter((line) => line.length > 0);
}

function parseSessionTimestamp(value: unknown): SessionTimestamp | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 128)
		return undefined;
	const epochMs = Date.parse(value);
	return Number.isFinite(epochMs) ? { value, epochMs } : undefined;
}

function parseMessageTimestamp(value: unknown): SessionTimestamp | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime())
		? { value: date.toISOString(), epochMs: value }
		: undefined;
}

function laterTimestamp(
	left: SessionTimestamp | undefined,
	right: SessionTimestamp | undefined,
): SessionTimestamp | undefined {
	if (!left) return right;
	if (!right) return left;
	return right.epochMs > left.epochMs ? right : left;
}

function activityTimestamp(
	entry: Record<string, unknown>,
): SessionTimestamp | undefined {
	if (entry.type !== "message") return undefined;
	if (
		!entry.message ||
		typeof entry.message !== "object" ||
		Array.isArray(entry.message)
	)
		return undefined;
	const message = entry.message as Record<string, unknown>;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	return (
		parseMessageTimestamp(message.timestamp) ??
		parseSessionTimestamp(entry.timestamp)
	);
}

async function parseSessionSummary(
	directory: string,
	name: string,
	cwd: string,
	activePath?: string,
): Promise<SessionSummary | undefined> {
	const filePath = resolveContainedPath(directory, name);
	if (!filePath) return undefined;

	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) return undefined;
		const sessionLines = await readSessionLines(filePath, fileStat.size);
		const headerValue = sessionLines.lines[0];
		if (!headerValue) return undefined;
		let parsedHeader: unknown;
		try {
			parsedHeader = JSON.parse(headerValue) as unknown;
		} catch {
			return undefined;
		}
		if (
			!parsedHeader ||
			typeof parsedHeader !== "object" ||
			Array.isArray(parsedHeader)
		)
			return undefined;
		const header = parsedHeader as SessionHeader;
		if (header.type !== "session" || header.cwd !== cwd) return undefined;

		let sessionName = "";
		let firstUserMessage = "";
		let lastActivity: SessionTimestamp | undefined;
		for (const line of sessionLines.lines.slice(1)) {
			let parsedEntry: unknown;
			try {
				parsedEntry = JSON.parse(line) as unknown;
			} catch {
				continue;
			}
			if (
				!parsedEntry ||
				typeof parsedEntry !== "object" ||
				Array.isArray(parsedEntry)
			)
				continue;
			const entry = parsedEntry as Record<string, unknown>;
			if (entry.type === "session_info" && typeof entry.name === "string")
				sessionName = entry.name;
			if (entry.type === "message") {
				if (!firstUserMessage) {
					const message =
						entry.message &&
						typeof entry.message === "object" &&
						!Array.isArray(entry.message)
							? (entry.message as Record<string, unknown>)
							: undefined;
					if (message?.role === "user") {
						const text = contentToText(message.content);
						if (text) firstUserMessage = text;
					}
				}
			}
			const activity = activityTimestamp(entry);
			lastActivity = laterTimestamp(lastActivity, activity);
		}

		const headerTimestamp = parseSessionTimestamp(header.timestamp);
		const fileTimestamp: SessionTimestamp = {
			value: fileStat.mtime.toISOString(),
			epochMs: fileStat.mtime.getTime(),
		};
		const createdAt = headerTimestamp ?? fileTimestamp;
		const effectiveLastActivity = lastActivity ?? createdAt;
		const excerpt = cleanExcerpt(firstUserMessage);
		return {
			path: filePath,
			title: sessionName.trim() || excerpt.slice(0, 54) || "Untitled",
			excerpt: excerpt.slice(0, 100),
			createdAt: createdAt.value,
			lastActivityAt: effectiveLastActivity.value,
			active: activePath === filePath,
		};
	} catch {
		return undefined;
	}
}

export async function listProjectSessions(
	cwd: string,
	activePath?: string,
	sessionDirectory?: string,
): Promise<SessionSummary[]> {
	// pi-lens-ignore: ts-path-traversal -- This option intentionally selects pi's storage root, not a child path., ts-path-traversal
	const agentRoot =
		// pi-lens-ignore: ts-path-traversal
		process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	// pi-lens-ignore: ts-path-traversal -- A custom session directory is an intentional storage root resolved against the workspace.
	const customDirectory = resolveSessionDirectory(cwd, sessionDirectory);
	// pi-lens-ignore: ts-path-traversal -- Default session children pass resolveContainedPath before filesystem access., ts-path-traversal
	const defaultSessionsRoot = path.resolve(agentRoot, "sessions");
	const directory =
		customDirectory ||
		resolveContainedPath(defaultSessionsRoot, sessionDirectoryName(cwd));
	if (!directory) return [];

	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return [];
	}

	const candidates = names
		.filter((name) => name === path.basename(name) && name.endsWith(".jsonl"))
		.sort((left, right) => left.localeCompare(right))
		.slice(-MAX_SESSION_FILES);
	const sessions = await Promise.all(
		candidates.map((name) =>
			parseSessionSummary(directory, name, cwd, activePath),
		),
	);

	return sessions
		.filter((session): session is SessionSummary => Boolean(session))
		.sort((left, right) => {
			const leftActivity = Date.parse(left.lastActivityAt ?? left.createdAt) || 0;
			const rightActivity =
				Date.parse(right.lastActivityAt ?? right.createdAt) || 0;
			return (
				rightActivity - leftActivity ||
				(Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0) ||
				left.path.localeCompare(right.path)
			);
		});
}

export async function deleteProjectSession(
	cwd: string,
	sessionPath: string,
	activePath?: string,
	sessionDirectory?: string,
): Promise<void> {
	const sessions = await listProjectSessions(cwd, activePath, sessionDirectory);
	const session = sessions.find((candidate) => candidate.path === sessionPath);
	if (!session) throw new Error("Session is not part of this workspace.");
	if (session.active) throw new Error("The active session cannot be deleted.");

	try {
		// pi-lens-ignore: ts-path-traversal -- The path must exactly match a validated project session returned above.
		await unlink(session.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error("Session no longer exists.");
		throw error;
	}
}
