import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Syntax highlighting for settled transcript code blocks.
 *
 * `undefined` means "do not highlight" — an unknown language, an oversized
 * block, or a highlighter failure. Callers fall back to plain escaped text, so
 * highlighting can never be the reason a message fails to render.
 */
export interface CodeHighlighter {
	highlight(code: string, language: string): string | undefined;
}

/**
 * Languages are registered explicitly rather than via the full bundle: the
 * complete highlight.js package is roughly an order of magnitude larger than
 * this subset, and the webview ships in the extension.
 */
const LANGUAGES: Record<string, unknown> = {
	bash,
	c,
	cpp,
	csharp,
	css,
	diff,
	dockerfile,
	go,
	ini,
	java,
	javascript,
	json,
	kotlin,
	lua,
	markdown,
	php,
	python,
	ruby,
	rust,
	scss,
	shell,
	sql,
	swift,
	typescript,
	xml,
	yaml,
};

/**
 * Fence tags mapped onto a registered language.
 *
 * Only an explicit, known tag is highlighted. Automatic language detection is
 * deliberately absent: it is expensive and frequently wrong on the short
 * fragments an assistant emits, and a mislabelled block is worse than a plain
 * one.
 */
const ALIASES: Record<string, string> = {
	bash: "bash",
	c: "c",
	"c++": "cpp",
	cc: "cpp",
	cjs: "javascript",
	cmd: "shell",
	console: "shell",
	cpp: "cpp",
	cs: "csharp",
	csharp: "csharp",
	css: "css",
	diff: "diff",
	docker: "dockerfile",
	dockerfile: "dockerfile",
	go: "go",
	golang: "go",
	h: "c",
	hpp: "cpp",
	htm: "xml",
	html: "xml",
	ini: "ini",
	java: "java",
	javascript: "javascript",
	js: "javascript",
	json: "json",
	json5: "json",
	jsonc: "json",
	jsx: "javascript",
	kotlin: "kotlin",
	kt: "kotlin",
	lua: "lua",
	markdown: "markdown",
	md: "markdown",
	mjs: "javascript",
	patch: "diff",
	php: "php",
	plist: "xml",
	py: "python",
	python: "python",
	rb: "ruby",
	rs: "rust",
	ruby: "ruby",
	rust: "rust",
	scss: "scss",
	sh: "bash",
	shell: "shell",
	sql: "sql",
	svg: "xml",
	swift: "swift",
	toml: "ini",
	ts: "typescript",
	tsx: "typescript",
	typescript: "typescript",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

/**
 * Per-block ceiling. Highlighting is synchronous, so an unbounded block would
 * block the webview's main thread; a very large paste degrades to plain text
 * instead of stalling the transcript.
 */
export const MAX_HIGHLIGHT_BYTES = 64 * 1024;

/**
 * Per-line ceiling, and the one that actually matters for hostile input.
 *
 * highlight.js cost grows quadratically in line length, not in total size. On
 * a 64 KiB block this measured 22ms as 80-column lines but 9.6 *seconds* as a
 * single line, with 2 KiB single lines at 9.5ms and 8 KiB at 146ms. Since
 * highlighting is synchronous, the single-line case would freeze the webview,
 * and a total-size ceiling cannot separate it from a perfectly ordinary large
 * file. Minified or single-line blocks therefore degrade to plain text.
 */
export const MAX_HIGHLIGHT_LINE_BYTES = 2 * 1024;

/** Bounds on the memo, so a long conversation cannot grow it without limit. */
export const MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;

let registered = false;

function ensureRegistered(): void {
	if (registered) return;
	for (const [name, definition] of Object.entries(LANGUAGES)) {
		hljs.registerLanguage(
			name,
			definition as Parameters<typeof hljs.registerLanguage>[1],
		);
	}
	registered = true;
}

/** Resolves a fence tag to a registered language, or `undefined` to skip highlighting. */
export function resolveLanguage(language: string): string | undefined {
	const tag = language.trim().toLowerCase();
	// A tag long enough to be suspicious is not a language name.
	if (tag.length === 0 || tag.length > 32) return undefined;
	return ALIASES[tag];
}

/**
 * Highlighter with a bounded LRU memo.
 *
 * The memo matters because a snapshot rebuilds every visible message: without
 * it, re-highlighting the whole transcript would repeat on each session refresh.
 */
export class HighlightJsHighlighter implements CodeHighlighter {
	private readonly cache = new Map<string, string>();
	private cacheBytes = 0;

	public highlight(code: string, language: string): string | undefined {
		const resolved = resolveLanguage(language);
		if (!resolved) return undefined;
		if (!withinHighlightLimits(code)) return undefined;

		const key = `${resolved}\u0000${code}`;
		const cached = this.cache.get(key);
		if (cached !== undefined) {
			// Refresh recency: re-inserting moves the key to the end of the Map's
			// insertion order, which is what makes eviction LRU rather than FIFO.
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}

		let html: string;
		try {
			ensureRegistered();
			html = hljs.highlight(code, {
				language: resolved,
				ignoreIllegals: true,
			}).value;
		} catch {
			// A highlighter failure must never break the message; the caller falls
			// back to plain escaped text.
			return undefined;
		}

		this.store(key, html);
		return html;
	}

	private store(key: string, html: string): void {
		const size = byteLength(html);
		// A single result larger than the whole budget is returned but not stored.
		if (size > MAX_CACHE_BYTES) return;
		this.cache.set(key, html);
		this.cacheBytes += size;
		while (
			this.cache.size > MAX_CACHE_ENTRIES ||
			this.cacheBytes > MAX_CACHE_BYTES
		) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			const evicted = this.cache.get(oldest.value);
			this.cache.delete(oldest.value);
			if (evicted !== undefined) this.cacheBytes -= byteLength(evicted);
		}
	}
}

/**
 * Checks both ceilings in one pass, bailing out as soon as either is exceeded.
 *
 * Measured in bytes rather than characters: the ceilings are about work done,
 * and a CJK-heavy block is roughly three times its character count.
 */
function withinHighlightLimits(code: string): boolean {
	let total = 0;
	let lineBytes = 0;
	for (let index = 0; index < code.length; index += 1) {
		const unit = code.charCodeAt(index);
		if (unit === 0x0a) {
			total += 1;
			if (total > MAX_HIGHLIGHT_BYTES) return false;
			lineBytes = 0;
			continue;
		}
		let size: number;
		if (unit < 0x80) size = 1;
		else if (unit < 0x800) size = 2;
		else if (unit >= 0xd800 && unit <= 0xdbff) {
			// Surrogate pair: 4 bytes for the pair, and the low half is skipped.
			size = 4;
			index += 1;
		} else size = 3;
		total += size;
		lineBytes += size;
		if (total > MAX_HIGHLIGHT_BYTES) return false;
		if (lineBytes > MAX_HIGHLIGHT_LINE_BYTES) return false;
	}
	return true;
}

function byteLength(value: string): number {
	// Counted without allocating a Buffer/TextEncoder per call: this runs for
	// every code block in a transcript rebuild.
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			// Surrogate pair: 4 bytes for the pair, and the low half is skipped.
			bytes += 4;
			index += 1;
		} else bytes += 3;
	}
	return bytes;
}
