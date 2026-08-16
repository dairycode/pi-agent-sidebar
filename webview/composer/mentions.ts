import type {
	WorkspaceEntrySuggestion,
	WorkspaceFileSuggestion,
} from "../../shared/protocol.js";

export interface MentionToken {
	start: number;
	end: number;
	query: string;
}

export interface MentionEditor {
	value: string;
	selectionStart: number | null;
	selectionEnd: number | null;
	focus(): void;
}

export interface MentionControllerOptions {
	panel: HTMLElement;
	list: HTMLElement;
	editor: MentionEditor;
	/** Asks the host for entries at the directory level encoded by `query`. */
	requestFiles(requestId: number, query: string): void;
	/** Turns a highlighted file into a composer reference. */
	commit(file: WorkspaceFileSuggestion, token: MentionToken): void;
	/** Rewrites the token to `@directory/` before browsing the next level. */
	navigate(directoryPath: string, token: MentionToken): void;
	announce(message: string): void;
	isEnabled(): boolean;
	position(): void;
	/** True when the offset sits inside an existing reference marker. */
	isProtectedOffset(offset: number): boolean;
	document?: Document;
}

/**
 * `@`-mention popup for workspace files.
 *
 * It mirrors the inline slash palette: the composer textarea stays the search
 * field, arrows move the highlight, and Enter/Tab pick a row. Unlike a global
 * file search, each response contains only the current directory's immediate
 * children. Picking a directory rewrites the token to `@path/` and requests the
 * next level; only picking a file creates a composer reference.
 *
 * File lists are too large to push into the webview, so every token change asks
 * the host and results are matched back by request id.
 *
 * The panel only becomes visible once a request comes back with rows. A file
 * mention is easy to type by accident (`@everyone`, an npm scope, an email), and
 * opening an empty panel on every `@` would put a flashing box over the
 * transcript. Waiting for a non-empty answer means prose never opens it.
 */
export class MentionController {
	private readonly document: Document;
	private open = false;
	private token: MentionToken | undefined;
	private entries: WorkspaceEntrySuggestion[] = [];
	private activeKey: string | undefined;
	private requestCounter = 0;
	private latestRequestId = -1;

	public constructor(private readonly options: MentionControllerOptions) {
		this.document = options.document ?? document;
	}

	public get isOpen(): boolean {
		return this.open;
	}

	/** Re-evaluates the token under the caret after an edit or caret move. */
	public sync(): void {
		if (!this.options.isEnabled()) {
			this.dismiss();
			return;
		}
		const token = this.mentionToken();
		if (!token) {
			this.dismiss();
			return;
		}
		// A repeat of the same token (a plain caret nudge inside it) still needs a
		// request when nothing is on screen yet, but not when rows are already up.
		if (this.open && this.token?.query === token.query) {
			this.token = token;
			return;
		}
		this.token = token;
		this.requestCounter += 1;
		this.latestRequestId = this.requestCounter;
		this.options.requestFiles(this.latestRequestId, token.query);
	}

	public applyResults(
		requestId: number,
		query: string,
		entries: WorkspaceEntrySuggestion[],
	): void {
		if (requestId !== this.latestRequestId) return;
		const token = this.mentionToken();
		if (!token || token.query !== query) {
			this.dismiss();
			return;
		}
		this.token = token;
		if (entries.length === 0) {
			this.dismiss();
			return;
		}
		this.entries = entries;
		if (
			!this.activeKey ||
			!entries.some((entry) => entryKey(entry) === this.activeKey)
		) {
			this.activeKey = entries[0] ? entryKey(entries[0]) : undefined;
		}
		this.render();
		this.open = true;
		this.options.panel.hidden = false;
		this.options.position();
	}

	public dismiss(): void {
		this.token = undefined;
		this.entries = [];
		this.activeKey = undefined;
		this.setActiveDescendant(undefined);
		if (!this.open) return;
		this.open = false;
		this.options.panel.hidden = true;
		this.options.list.replaceChildren();
	}

	public reposition(): void {
		if (this.open) this.options.position();
	}

	/** Returns true when the key was consumed by the popup. */
	public handleKeydown(event: KeyboardEvent): boolean {
		if (!this.open) return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			this.moveActive(event.key === "ArrowDown" ? 1 : -1);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			this.dismiss();
			this.options.editor.focus();
			return true;
		}
		if (event.key !== "Enter" && event.key !== "Tab") return false;
		if (event.shiftKey || event.isComposing) return false;
		const entry = this.entries.find(
			(candidate) => entryKey(candidate) === this.activeKey,
		);
		if (!entry) return false;
		event.preventDefault();
		this.select(entry);
		return true;
	}

	/**
	 * Finds the `@token` the caret sits in.
	 *
	 * The `@` has to start the text or follow whitespace, so `user@example.com`
	 * and `npm i @scope/pkg`-style prose never trigger it, and the token ends at
	 * the first whitespace. Offsets inside an existing reference marker are
	 * skipped: those markers are themselves `@path` text, and treating one as a
	 * live query would offer to re-add the file the caret is resting on.
	 */
	private mentionToken(): MentionToken | undefined {
		const text = this.options.editor.value;
		const caret = this.options.editor.selectionStart;
		if (typeof caret !== "number" || caret !== this.options.editor.selectionEnd)
			return undefined;
		let start = caret;
		while (start > 0 && !/\s/u.test(text[start - 1] ?? "")) start -= 1;
		if (text[start] !== "@") return undefined;
		let end = start + 1;
		while (end < text.length && !/\s/u.test(text[end] ?? "")) end += 1;
		if (caret < start + 1 || caret > end) return undefined;
		if (this.options.isProtectedOffset(start + 1)) return undefined;
		return { start, end, query: text.slice(start + 1, end) };
	}

	private select(entry: WorkspaceEntrySuggestion): void {
		const token = this.token ?? this.mentionToken();
		if (!token) return;
		if (entry.kind === "directory") {
			this.dismiss();
			this.options.navigate(entry.displayPath, token);
			this.options.announce(`Browsing ${entry.displayPath}`);
			this.sync();
			return;
		}
		this.dismiss();
		this.options.commit(entry, token);
		this.options.announce(`Added ${entry.displayPath}`);
	}

	private moveActive(delta: number): void {
		if (this.entries.length === 0) return;
		const current = this.entries.findIndex(
			(entry) => entryKey(entry) === this.activeKey,
		);
		const next = (current + delta + this.entries.length) % this.entries.length;
		this.activeKey = this.entries[next]
			? entryKey(this.entries[next])
			: undefined;
		this.highlight(true);
	}

	/** Renders only the current directory's immediate files and folders. */
	private render(): void {
		const rows = this.entries.map((entry, index) =>
			this.createRow(entry, index),
		);
		this.options.list.replaceChildren(...rows);
		this.highlight(false);
	}

	private createRow(
		entry: WorkspaceEntrySuggestion,
		index: number,
	): HTMLElement {
		const row = this.document.createElement("div");
		row.className = `command-row mention-row is-${entry.kind}`;
		row.id = `mention-row-${index}`;
		row.setAttribute("role", "option");
		row.dataset.key = entryKey(entry);
		row.tabIndex = -1;
		row.title = entry.displayPath;

		const icon = this.document.createElement("i");
		icon.className = `codicon codicon-${
			entry.kind === "directory" ? "folder" : "file"
		} mention-row-icon`;
		icon.setAttribute("aria-hidden", "true");

		const name = this.document.createElement("span");
		name.className = "command-row-name";
		name.textContent = `${basenameOf(entry.displayPath)}${
			entry.kind === "directory" ? "/" : ""
		}`;
		row.append(icon, name);

		if (entry.kind === "directory") {
			const arrow = this.document.createElement("i");
			arrow.className = "codicon codicon-chevron-right mention-row-arrow";
			arrow.setAttribute("aria-hidden", "true");
			row.append(arrow);
		}

		// Mousedown preserves the textarea caret used as the insertion point.
		row.addEventListener("mousedown", (event) => {
			event.preventDefault();
			this.select(entry);
		});
		return row;
	}

	private highlight(scroll: boolean): void {
		let activeId: string | undefined;
		for (const row of this.options.list.querySelectorAll<HTMLElement>(
			".mention-row",
		)) {
			const active = row.dataset.key === this.activeKey;
			row.classList.toggle("is-active", active);
			row.setAttribute("aria-selected", String(active));
			if (!active) continue;
			activeId = row.id;
			if (scroll) row.scrollIntoView({ block: "nearest" });
		}
		this.setActiveDescendant(activeId);
	}

	private setActiveDescendant(rowId: string | undefined): void {
		const host = this.options.editor as unknown as Partial<HTMLElement>;
		if (typeof host.setAttribute !== "function") return;
		if (rowId) host.setAttribute("aria-activedescendant", rowId);
		else host.removeAttribute?.("aria-activedescendant");
	}
}

function entryKey(entry: WorkspaceEntrySuggestion): string {
	return `${entry.kind}:${entry.displayPath.toLocaleLowerCase()}`;
}

function basenameOf(displayPath: string): string {
	return displayPath.slice(displayPath.lastIndexOf("/") + 1);
}
