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

function sessionDirectoryName(cwd: string): string {
	const normalized = cwd.replace(/^[/\\]+/, "").replace(/[:/\\]+/g, "-");
	return path.basename(`--${normalized}--`);
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

async function readSessionText(
	filePath: string,
	size: number,
): Promise<string> {
	if (size <= MAX_FULL_READ_BYTES) return readFile(filePath, "utf8");

	const handle = await open(filePath, "r");
	try {
		const headLength = Math.min(size, HEAD_READ_BYTES);
		const tailLength = Math.min(
			Math.max(0, size - headLength),
			TAIL_READ_BYTES,
		);
		const head = Buffer.alloc(headLength);
		const tail = Buffer.alloc(tailLength);
		await handle.read(head, 0, headLength, 0);
		if (tailLength > 0)
			await handle.read(tail, 0, tailLength, size - tailLength);
		return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
	} finally {
		await handle.close();
	}
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
		const contents = await readSessionText(filePath, fileStat.size);
		const lines = contents.trim().split("\n");
		const header = JSON.parse(lines[0] ?? "{}") as SessionHeader;
		if (header.type !== "session" || header.cwd !== cwd) return undefined;

		let sessionName = "";
		let firstUserMessage = "";
		for (let index = 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (!line) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (entry.type === "session_info" && typeof entry.name === "string")
				sessionName = entry.name;
			if (!firstUserMessage && entry.type === "message") {
				const message = entry.message as Record<string, unknown> | undefined;
				if (message?.role === "user")
					firstUserMessage = contentToText(message.content);
			}
		}

		const excerpt = cleanExcerpt(firstUserMessage);
		return {
			path: filePath,
			title: sessionName.trim() || excerpt.slice(0, 54) || "Untitled",
			excerpt: excerpt.slice(0, 100),
			timestamp:
				typeof header.timestamp === "string"
					? header.timestamp
					: fileStat.mtime.toISOString(),
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
		.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
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
