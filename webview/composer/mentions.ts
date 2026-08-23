import type {
	WorkspaceEntrySuggestion,
	WorkspaceReferenceSuggestion,
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
	/** Turns a confirmed file or directory into a composer reference. */
	commit(resource: WorkspaceReferenceSuggestion, token: MentionToken): void;
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
 * next level. The host-confirmed directory stays pending while the user browses;
 * typing whitespace to end the token commits that directory as a reference.
 * Continuing the path clears the pending directory and keeps browsing. A
 * complete directory path typed directly follows the same rule: the host only
 * confirms it, and the user's whitespace commits it without synthesizing or
 * removing any separator characters.
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
	private pendingDirectory:
		| { resource: WorkspaceReferenceSuggestion; token: MentionToken }
		| undefined;
	private endedDirectoryToken: MentionToken | undefined;

	public constructor(private readonly options: MentionControllerOptions) {
		this.document = options.document ?? document;
	}

	public get isOpen(): boolean {
		return this.open;
	}

	/**
	 * Re-evaluates the token under the caret after a caret move.
	 *
	 * Callers that just moved the caret use this; a real text edit goes through
	 * syncAfterInput() instead, because only an edit can end a `@path/` token.
	 */
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
		this.trackToken(token);
	}

	/**
	 * Re-evaluates the token after a text edit.
	 *
	 * Typing whitespace ends a `@path/` token, which is what commits the
	 * directory it names. The terminator itself is never consumed or synthesized:
	 * committing only replaces the token span.
	 */
	public syncAfterInput(): void {
		if (!this.options.isEnabled()) {
			this.dismiss();
			return;
		}
		const token = this.mentionToken();
		if (token) {
			this.trackToken(token);
			return;
		}
		if (this.resolveEndedDirectory()) return;
		this.dismiss();
	}

	/** Requests the level the caret's token names, dropping stale directory state. */
	private trackToken(token: MentionToken): void {
		this.endedDirectoryToken = undefined;
		if (
			this.pendingDirectory &&
			this.pendingDirectory.token.query !== token.query
		) {
			this.pendingDirectory = undefined;
		}
		// A repeat of the same token (a plain caret nudge inside it) still needs a
		// request when nothing is on screen yet, but not when rows are already up.
		if (this.open && this.token?.query === token.query) {
			this.token = token;
			return;
		}
		this.token = token;
		this.requestLevel(token.query);
	}

	/**
	 * Handles a caret that just left a `@path/` token.
	 *
	 * Returns true once the directory is committed, already awaiting its
	 * confirmation, or newly sent for one, so the caller leaves the state alone.
	 */
	private resolveEndedDirectory(): boolean {
		if (this.commitPendingDirectory()) return true;
		if (
			this.endedDirectoryToken &&
			this.tokenStillEndsAtWhitespace(this.endedDirectoryToken)
		) {
			// Still waiting on the host; keep the token so the answer can commit it.
			this.closePopup();
			return true;
		}
		const endedToken = this.tokenEndingBeforeCaret();
		if (!endedToken) return false;
		this.endedDirectoryToken = endedToken;
		this.closePopup();
		this.requestLevel(endedToken.query);
		return true;
	}

	private requestLevel(query: string): void {
		this.requestCounter += 1;
		this.latestRequestId = this.requestCounter;
		this.options.requestFiles(this.latestRequestId, query);
	}

	public applyResults(
		requestId: number,
		query: string,
		entries: WorkspaceEntrySuggestion[],
	): void {
		if (requestId !== this.latestRequestId) return;
		const currentDirectory = entries.find(isCurrentDirectoryReference);
		const endedToken = this.endedDirectoryToken;
		if (endedToken && endedToken.query === query) {
			this.endedDirectoryToken = undefined;
			if (currentDirectory && this.tokenStillEndsAtWhitespace(endedToken)) {
				this.closePopup();
				this.options.commit(currentDirectory, endedToken);
				this.options.announce(`Added ${currentDirectory.displayPath}`);
			} else {
				this.dismiss();
			}
			return;
		}
		const token = this.mentionToken();
		if (!token || token.query !== query) {
			this.dismiss();
			return;
		}
		this.token = token;
		// A confirmed directory is staged the same way however the caret got here —
		// Enter on a row or a manually typed trailing `/`. Neither closes the popup,
		// so both keep listing this level's children while the directory waits for
		// whitespace to commit it.
		if (currentDirectory) {
			this.pendingDirectory = { resource: currentDirectory, token };
		}
		const visibleEntries = entries.filter(
			(entry) => !isCurrentDirectoryReference(entry),
		);
		if (visibleEntries.length === 0) {
			this.closePopup();
			return;
		}
		this.entries = visibleEntries;
		if (
			!this.activeKey ||
			!visibleEntries.some((entry) => entryKey(entry) === this.activeKey)
		) {
			this.activeKey = visibleEntries[0]
				? entryKey(visibleEntries[0])
				: undefined;
		}
		this.render();
		this.open = true;
		this.options.panel.hidden = false;
		this.options.position();
	}

	public dismiss(): void {
		this.pendingDirectory = undefined;
		this.endedDirectoryToken = undefined;
		this.closePopup();
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
		if (entry.kind === "directory" && !isCurrentDirectoryReference(entry)) {
			this.pendingDirectory = undefined;
			this.closePopup();
			this.options.navigate(entry.displayPath, token);
			this.options.announce(`Browsing ${entry.displayPath}`);
			this.sync();
			return;
		}
		if (!isReferenceSuggestion(entry)) return;
		this.dismiss();
		this.options.commit(entry, token);
		this.options.announce(`Added ${entry.displayPath}`);
	}

	private tokenEndingBeforeCaret(): MentionToken | undefined {
		const text = this.options.editor.value;
		const caret = this.options.editor.selectionStart;
		if (
			typeof caret !== "number" ||
			caret !== this.options.editor.selectionEnd ||
			caret < 2 ||
			!/\s/u.test(text[caret - 1] ?? "")
		) {
			return undefined;
		}
		let end = caret - 1;
		while (end > 0 && /\s/u.test(text[end - 1] ?? "")) end -= 1;
		let start = end;
		while (start > 0 && !/\s/u.test(text[start - 1] ?? "")) start -= 1;
		if (text[start] !== "@" || text[end - 1] !== "/") return undefined;
		if (this.options.isProtectedOffset(start + 1)) return undefined;
		return { start, end, query: text.slice(start + 1, end) };
	}

	private tokenStillEndsAtWhitespace(token: MentionToken): boolean {
		const text = this.options.editor.value;
		return (
			text.slice(token.start, token.end) === `@${token.query}` &&
			/^\s/u.test(text.slice(token.end))
		);
	}

	private commitPendingDirectory(): boolean {
		const pending = this.pendingDirectory;
		if (!pending) return false;
		if (!this.tokenStillEndsAtWhitespace(pending.token)) {
			this.pendingDirectory = undefined;
			return false;
		}
		this.pendingDirectory = undefined;
		this.closePopup();
		this.options.commit(pending.resource, pending.token);
		this.options.announce(`Added ${pending.resource.displayPath}`);
		return true;
	}

	private closePopup(): void {
		this.token = undefined;
		this.entries = [];
		this.activeKey = undefined;
		this.setActiveDescendant(undefined);
		if (!this.open) return;
		this.open = false;
		this.options.panel.hidden = true;
		this.options.list.replaceChildren();
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

function isCurrentDirectoryReference(
	entry: WorkspaceEntrySuggestion,
): entry is WorkspaceReferenceSuggestion & { kind: "directory" } {
	return (
		entry.kind === "directory" && entry.current === true && Boolean(entry.uri)
	);
}

function isReferenceSuggestion(
	entry: WorkspaceEntrySuggestion,
): entry is WorkspaceReferenceSuggestion {
	return entry.kind === "file" || isCurrentDirectoryReference(entry);
}

function entryKey(entry: WorkspaceEntrySuggestion): string {
	return `${entry.kind}:${entry.displayPath.toLocaleLowerCase()}`;
}

function basenameOf(displayPath: string): string {
	return displayPath.slice(displayPath.lastIndexOf("/") + 1);
}
