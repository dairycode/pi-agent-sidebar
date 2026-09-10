import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

/**
 * Image types the sidebar renders from a file path.
 *
 * An allow list rather than "anything the browser can decode": without it the
 * resolver would hand out a readable URI for every file a transcript names, and
 * the extension would be serving whatever else sits next to the images. `.svg` is
 * in it for diagrams and icons, and is safe here only because every consumer puts
 * the URI in an `<img src>`: that context runs no scripts and loads no external
 * references, and the webview CSP admits nothing but the extension's own origin.
 */
const RENDERABLE_IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".avif",
	".svg",
]);

/**
 * Ceiling for one image, checked before handing out a URI.
 *
 * The webview holds the decoded bitmap in memory, so a path pointing at a
 * multi-gigabyte file would freeze the sidebar instead of showing a picture.
 */
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;

/** Marks a Windows drive letter, which looks like a URI scheme but is a path. */
const DRIVE_LETTER_PATTERN = /^[a-z]:[\\/]/iu;
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/iu;

/**
 * Real-path canonicalization, injectable so tests can walk a made-up tree
 * instead of the machine's file system.
 */
export interface MediaPathResolver {
	/** Synchronous form: `localResourceRoots` is built before the view exists. */
	realpathSync(target: string): string;
	realpath(target: string): Promise<string>;
}

const nodeMediaPathResolver: MediaPathResolver = {
	realpathSync,
	realpath,
};

/**
 * Turns image paths written into a transcript into URIs the webview can load.
 *
 * A webview cannot reach the file system: a relative path in Markdown resolves
 * against the webview's own origin, and only the host can call `asWebviewUri`.
 * Everything a transcript names is treated as untrusted — a path is resolved
 * only inside a workspace folder or the temp directory, and only after
 * canonicalization, so a symlink cannot walk out of those roots. A relative path
 * is resolved against pi's working directory first; that directory is one of the
 * workspace folders, not a root of its own.
 */
export class TranscriptMedia {
	private readonly canonicalRoots = new Map<string, string>();

	public constructor(
		private readonly workspaceRoots: () => readonly string[],
		private readonly workingDirectory: () => string | undefined,
		private readonly pathResolver: MediaPathResolver = nodeMediaPathResolver,
	) {}

	/**
	 * Directories a transcript image may live in, canonicalized.
	 *
	 * Read live rather than cached: a workspace folder added after the view was
	 * created has a path the sidebar may legitimately show, and freezing the list
	 * at view creation would refuse it. Canonicalization itself is memoized per
	 * root, because resolution needs it on every image while the roots rarely
	 * change, and the synchronous form is the one file system call here.
	 */
	public roots(): string[] {
		return [
			...new Set(
				[...this.workspaceRoots(), ...tempRoots()].map((root) =>
					this.canonicalRoot(root),
				),
			),
		];
	}

	private canonicalRoot(root: string): string {
		const cached = this.canonicalRoots.get(root);
		if (cached !== undefined) return cached;
		let canonical: string;
		try {
			canonical = this.pathResolver.realpathSync(root);
		} catch {
			// A root that does not exist cannot contain anything; keeping its resolved
			// form costs nothing and keeps the list stable.
			canonical = path.resolve(root);
		}
		this.canonicalRoots.set(root, canonical);
		return canonical;
	}

	/** The URI for `source`, or undefined when it must not be loaded. */
	public async resolve(source: string): Promise<vscode.Uri | undefined> {
		// Every check below is best effort rather than an invariant: canonicalization,
		// containment, `stat` and the editor's own read are separate syscalls, so a
		// writer inside an allowed root can still swap the file after the size check.
		// An `<img>` cannot read bytes back out, the editor re-applies
		// `localResourceRoots` when it loads the URI, and the extension check happened
		// before the swap — so the worst case is a decoded bitmap, not disclosure.
		const candidate = localCandidate(source, this.workingDirectory());
		if (!candidate) return undefined;
		if (!RENDERABLE_IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase()))
			return undefined;

		let canonical: string;
		try {
			canonical = await this.pathResolver.realpath(candidate);
		} catch {
			return undefined;
		}
		if (!this.isAllowed(canonical)) return undefined;

		let fileStat: vscode.FileStat;
		try {
			fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(canonical));
		} catch {
			return undefined;
		}
		if ((fileStat.type & vscode.FileType.File) === 0) return undefined;
		if (fileStat.size > MAX_MEDIA_BYTES) return undefined;
		return vscode.Uri.file(canonical);
	}

	private isAllowed(canonical: string): boolean {
		return this.roots().some((root) => {
			const relative = path.relative(root, canonical);
			// A `..` segment leaves the root; `..cache/preview.png` is a legal name
			// inside it that merely looks like one. `path.relative` returns an absolute
			// path for a different drive or a UNC share, which is outside too.
			if (relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
			if (path.isAbsolute(relative)) return false;
			return relative.length > 0;
		});
	}
}

/**
 * Temp directories a transcript may name.
 *
 * Screenshots and rendered previews land here, which is the only reason they are
 * allowed at all. `/tmp` is listed beside `os.tmpdir()` because on macOS it is a
 * symlink to `/private/tmp`, and canonicalization would otherwise drop the one
 * directory other tools actually write to. Allow-listing a shared directory this
 * wide is a deliberate trade: it buys image previews for tool output, and it
 * also means a prompt can name any image sitting in the machine's temp space.
 */
function tempRoots(): string[] {
	return [os.tmpdir(), "/tmp"];
}

/**
 * The file system path `source` names, or undefined when it names something
 * other than a local file.
 *
 * Remote URLs and `data:` URIs are handled by the renderer without a round trip,
 * so anything else carrying a scheme is refused here rather than guessed at.
 */
function localCandidate(
	source: string,
	workingDirectory: string | undefined,
): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;

	const scheme = SCHEME_PATTERN.exec(trimmed)?.[1]?.toLowerCase();
	if (scheme && !DRIVE_LETTER_PATTERN.test(trimmed)) {
		if (scheme !== "file") return undefined;
		try {
			return vscode.Uri.parse(trimmed, true).fsPath || undefined;
		} catch {
			return undefined;
		}
	}

	const target = decodePath(trimmed.replace(/[?#].*$/su, ""));
	if (!target) return undefined;
	if (path.isAbsolute(target)) return path.normalize(target);
	return workingDirectory ? path.resolve(workingDirectory, target) : undefined;
}

/**
 * Percent-decodes a path, keeping the literal form when it is not encoded.
 *
 * Markdown destinations are commonly written escaped (`my%20file.png`), but `%`
 * is also a legal file name character, so a malformed escape means the path was
 * literal after all.
 */
function decodePath(value: string): string {
	if (!value.includes("%")) return value;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
