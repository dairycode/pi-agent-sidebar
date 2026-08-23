import * as vscode from "vscode";
import {
	MAX_WORKSPACE_ENTRY_SUGGESTIONS,
	type WorkspaceEntrySuggestion,
} from "../../shared/protocol.js";

/**
 * Supplies one directory level at a time to the composer's `@` browser.
 *
 * The source list comes from `vscode.workspace.findFiles`, which applies the
 * user's `files.exclude` and `search.exclude` settings. Directories are derived
 * from those visible files, so excluded/generated trees and empty directories
 * do not appear in the popup.
 *
 * Results are cached because the query changes on every keystroke. A watcher
 * invalidates the cache when files appear or disappear, and a short TTL covers
 * renames that VS Code reports as separate create/delete events.
 */
const CANDIDATE_LIMIT = 20_000;
const CACHE_TTL_MS = 30_000;

export interface WorkspaceFileCandidate {
	uri: vscode.Uri;
	displayPath: string;
}

export class WorkspaceFileSearch implements vscode.Disposable {
	private candidates: WorkspaceFileCandidate[] | undefined;
	private pending: Promise<WorkspaceFileCandidate[]> | undefined;
	private loadedAt = 0;
	private readonly watcher: vscode.FileSystemWatcher;
	private readonly disposables: vscode.Disposable[] = [];

	public constructor() {
		this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
		this.disposables.push(
			this.watcher,
			this.watcher.onDidCreate(() => this.invalidate()),
			this.watcher.onDidDelete(() => this.invalidate()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
		);
	}

	public dispose(): void {
		for (const disposable of this.disposables) disposable.dispose();
		this.disposables.length = 0;
	}

	public invalidate(): void {
		this.candidates = undefined;
		this.pending = undefined;
		this.loadedAt = 0;
	}

	public async search(query: string): Promise<WorkspaceEntrySuggestion[]> {
		const entries = listWorkspaceEntries(await this.load(), query);
		const currentDirectory = await resolveCurrentDirectory(query);
		return currentDirectory
			? [
					currentDirectory,
					...entries.filter(
						(entry) => entry.displayPath !== currentDirectory.displayPath,
					),
				].slice(0, MAX_WORKSPACE_ENTRY_SUGGESTIONS)
			: entries;
	}

	private async load(): Promise<WorkspaceFileCandidate[]> {
		if (this.candidates && Date.now() - this.loadedAt < CACHE_TTL_MS) {
			return this.candidates;
		}
		// Concurrent keystrokes share one workspace walk.
		this.pending ??= this.collect();
		try {
			const candidates = await this.pending;
			this.candidates = candidates;
			this.loadedAt = Date.now();
			return candidates;
		} finally {
			this.pending = undefined;
		}
	}

	private async collect(): Promise<WorkspaceFileCandidate[]> {
		const uris = await vscode.workspace.findFiles(
			"**/*",
			undefined,
			CANDIDATE_LIMIT,
		);
		return uris.map((uri) => createCandidate(uri));
	}
}

export function createCandidate(uri: vscode.Uri): WorkspaceFileCandidate {
	return { uri, displayPath: workspaceDisplayPath(uri) };
}

/**
 * Builds the path used by both directory browsing and the final reference.
 * Multi-root workspaces include the folder name so their roots remain distinct.
 */
export function workspaceDisplayPath(uri: vscode.Uri): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) return uri.fsPath || uri.toString(true);
	const includeWorkspaceFolder =
		(vscode.workspace.workspaceFolders?.length ?? 0) > 1;
	return vscode.workspace
		.asRelativePath(uri, includeWorkspaceFolder)
		.split(/[\\/]/u)
		.join("/");
}

/**
 * Lists only the immediate children of the directory encoded by `query`.
 *
 * Examples:
 * - `""` lists workspace-root files and folders.
 * - `"sr"` filters names at the workspace root; it never finds `src/a.ts` as a
 *   file, only `src` as a directory.
 * - `"src/"` lists the immediate children of `src`.
 * - `"src/pro"` filters names inside `src`.
 *
 * Matching within the current level is a case-insensitive subsequence match, so
 * navigation remains quick without leaking descendants into the result list.
 */
export function listWorkspaceEntries(
	candidates: readonly WorkspaceFileCandidate[],
	query: string,
	limit = MAX_WORKSPACE_ENTRY_SUGGESTIONS,
): WorkspaceEntrySuggestion[] {
	const normalized = normalizeQuery(query);
	const separator = normalized.lastIndexOf("/");
	const directory = separator >= 0 ? normalized.slice(0, separator) : "";
	const nameQuery = normalized.slice(separator + 1).toLocaleLowerCase();
	const directoryPrefix = directory ? `${directory}/` : "";
	const directoryPrefixLower = directoryPrefix.toLocaleLowerCase();
	const entries = new Map<string, WorkspaceEntrySuggestion>();

	for (const candidate of candidates) {
		const pathLower = candidate.displayPath.toLocaleLowerCase();
		if (!pathLower.startsWith(directoryPrefixLower)) continue;
		const remainder = candidate.displayPath.slice(directoryPrefix.length);
		if (!remainder) continue;

		const childSeparator = remainder.indexOf("/");
		const name =
			childSeparator >= 0 ? remainder.slice(0, childSeparator) : remainder;
		if (matchName(name, nameQuery) === undefined) continue;

		if (childSeparator >= 0) {
			const displayPath = directoryPrefix + name;
			entries.set(`directory:${displayPath.toLocaleLowerCase()}`, {
				kind: "directory",
				displayPath,
			});
			continue;
		}

		entries.set(`file:${candidate.displayPath.toLocaleLowerCase()}`, {
			kind: "file",
			displayPath: candidate.displayPath,
			uri: candidate.uri.toString(),
		});
	}

	return [...entries.values()]
		.sort((left, right) => compareEntries(left, right, nameQuery))
		.slice(0, limit);
}

async function resolveCurrentDirectory(
	query: string,
): Promise<WorkspaceEntrySuggestion | undefined> {
	if (!query.replace(/\\/gu, "/").endsWith("/")) return undefined;
	const displayPath = normalizeQuery(query).replace(/\/+$/u, "");
	if (!displayPath || displayPath.split("/").includes("..")) return undefined;

	const folders = vscode.workspace.workspaceFolders ?? [];
	let folder: vscode.WorkspaceFolder | undefined;
	let relativePath = displayPath;
	if (folders.length > 1) {
		const separator = displayPath.indexOf("/");
		const folderName =
			separator >= 0 ? displayPath.slice(0, separator) : displayPath;
		folder = folders.find((candidate) => candidate.name === folderName);
		if (!folder) return undefined;
		relativePath = separator >= 0 ? displayPath.slice(separator + 1) : "";
	} else {
		folder = folders[0];
	}
	if (!folder || !relativePath) return undefined;

	const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split("/"));
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if ((stat.type & vscode.FileType.Directory) === 0) return undefined;
		return {
			kind: "directory",
			displayPath,
			uri: uri.toString(),
			current: true,
		};
	} catch {
		return undefined;
	}
}

function normalizeQuery(query: string): string {
	return query
		.replace(/\\/gu, "/")
		.replace(/^\.\//u, "")
		.replace(/^\/+/, "")
		.replace(/\/{2,}/gu, "/");
}

/** Returns a compactness score for a name-level subsequence match. */
function matchName(name: string, needle: string): number | undefined {
	if (!needle) return 0;
	const haystack = name.toLocaleLowerCase();
	let first = -1;
	let previous = -1;
	let index = 0;
	for (let cursor = 0; cursor < haystack.length; cursor += 1) {
		if (haystack[cursor] !== needle[index]) continue;
		if (first < 0) first = cursor;
		previous = cursor;
		index += 1;
		if (index === needle.length) {
			const spread = previous - first - needle.length + 1;
			return (first === 0 ? 0 : 100) + spread + first;
		}
	}
	return undefined;
}

function compareEntries(
	left: WorkspaceEntrySuggestion,
	right: WorkspaceEntrySuggestion,
	nameQuery: string,
): number {
	const kindOrder =
		Number(left.kind === "file") - Number(right.kind === "file");
	if (kindOrder !== 0) return kindOrder;
	const leftName = basenameOf(left.displayPath);
	const rightName = basenameOf(right.displayPath);
	return (
		(matchName(leftName, nameQuery) ?? Number.MAX_SAFE_INTEGER) -
			(matchName(rightName, nameQuery) ?? Number.MAX_SAFE_INTEGER) ||
		leftName.localeCompare(rightName)
	);
}

function basenameOf(displayPath: string): string {
	return displayPath.slice(displayPath.lastIndexOf("/") + 1);
}
