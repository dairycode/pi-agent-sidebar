/**
 * Sticky turn label for the transcript.
 *
 * A long reply pushes the prompt that caused it out of view, so the transcript
 * stops answering "what did I ask to get this?". This pins the prompt whose turn
 * the viewport currently sits inside, the way a contact list pins the letter
 * you are scrolled into: scrolling back through history swaps the label to each
 * earlier prompt, and it disappears once the viewport is above the first one.
 *
 * The label is cloned from the already-rendered message rather than rebuilt from
 * message state, so it inherits the same reference chips, context stripping, and
 * escaping as the real transcript. It is only re-cloned when the turn changes;
 * doing it on every scroll frame would discard the expanded state mid-gesture.
 */

/** Slack allowed before a prompt counts as fully scrolled past the top edge. */
const TOP_EDGE_TOLERANCE_PX = 4;

export interface PinnedPromptRect {
	readonly top: number;
	readonly bottom: number;
}

export interface PinnedPromptElement {
	getBoundingClientRect(): PinnedPromptRect;
	querySelector(selector: string): PinnedPromptSource | null;
	/** Narrowed to the literal the DOM accepts so real elements structurally match. */
	scrollIntoView(options?: { block?: "start" }): void;
}

interface PinnedPromptSource {
	readonly textContent: string | null;
	cloneNode(deep: boolean): PinnedPromptClone;
}

interface PinnedPromptClone {
	readonly childNodes: ArrayLike<unknown> & Iterable<unknown>;
	querySelectorAll(selector: string): Iterable<{
		removeAttribute(name: string): void;
	}>;
}

interface PinnedPromptRow {
	hidden: boolean;
	readonly classList: { toggle(name: string, force?: boolean): unknown };
}

interface PinnedPromptText {
	readonly scrollWidth: number;
	readonly clientWidth: number;
	replaceChildren(...nodes: unknown[]): void;
}

interface PinnedPromptToggle {
	hidden: boolean;
	title: string;
	setAttribute(name: string, value: string): void;
}

export interface PinnedPromptOptions {
	/** The scrolling transcript, whose top edge defines the current turn. */
	viewport: { getBoundingClientRect(): PinnedPromptRect };
	/** Returns the rendered user messages, oldest first. */
	prompts(): readonly PinnedPromptElement[];
	row: PinnedPromptRow;
	text: PinnedPromptText;
	toggle: PinnedPromptToggle;
}

export class PinnedPromptController {
	private signature: string | undefined;
	private target: PinnedPromptElement | undefined;
	private expanded = false;
	private canExpand = false;

	public constructor(private readonly options: PinnedPromptOptions) {}

	/** True while a turn label is on screen. */
	public get isPinned(): boolean {
		return !this.options.row.hidden;
	}

	/** The prompt the label currently describes, for tests and scroll-back. */
	public get pinnedText(): string | undefined {
		return this.signature?.slice(this.signature.indexOf(":") + 1);
	}

	/**
	 * Re-evaluates which turn the viewport is inside.
	 *
	 * Safe to call on every scroll frame: the only unconditional work is one
	 * bounding-rect read per prompt scanned, and scanning starts at the newest
	 * prompt so it normally stops on the first or second candidate.
	 */
	public sync(): void {
		const active = this.activeTurn();
		const source = active?.element.querySelector(".user-message-text");
		const text = source?.textContent;
		if (!active || !source || !text?.trim()) {
			this.options.row.hidden = true;
			this.signature = undefined;
			this.target = undefined;
			return;
		}

		this.target = active.element;
		// The index is part of the identity because neighbouring turns can carry
		// identical text ("continue", "go on") and the label must still refresh.
		const signature = `${active.index}:${text}`;
		if (signature !== this.signature) {
			this.signature = signature;
			this.expanded = false;
			this.options.text.replaceChildren(...inertClone(source));
		}
		this.options.row.hidden = false;
		// Overflow is only measurable while collapsed and visible: expanding
		// switches to wrapped text, which removes the horizontal overflow this
		// reads, and a hidden element reports zero metrics. Re-measured on every
		// collapsed pass so dragging the sidebar edge keeps the toggle honest.
		if (!this.expanded) {
			this.options.row.classList.toggle("is-expanded", false);
			this.canExpand =
				this.options.text.scrollWidth > this.options.text.clientWidth + 1 ||
				text.includes("\n");
		}
		this.applyExpansion();
	}

	/** Expands or collapses the label without re-reading the transcript. */
	public toggleExpanded(): void {
		this.expanded = !this.expanded;
		this.applyExpansion();
	}

	/** Scrolls the transcript to the prompt the label describes. */
	public revealActivePrompt(): void {
		this.target?.scrollIntoView({ block: "start" });
	}

	/**
	 * Finds the newest prompt that has fully scrolled past the top edge.
	 *
	 * Everything visible below such a prompt belongs to its turn, so it is the
	 * one worth labelling. Requiring the whole prompt to be past the edge keeps a
	 * partly visible prompt unlabelled, so the label never duplicates text the
	 * user can already read.
	 */
	private activeTurn():
		| { element: PinnedPromptElement; index: number }
		| undefined {
		const topEdge =
			this.options.viewport.getBoundingClientRect().top + TOP_EDGE_TOLERANCE_PX;
		const prompts = this.options.prompts();
		for (let index = prompts.length - 1; index >= 0; index -= 1) {
			const element = prompts[index];
			if (element && element.getBoundingClientRect().bottom < topEdge) {
				return { element, index };
			}
		}
		return undefined;
	}

	private applyExpansion(): void {
		const expanded = this.expanded && this.canExpand;
		this.options.row.classList.toggle("is-expanded", expanded);
		this.options.toggle.hidden = !this.canExpand;
		this.options.toggle.setAttribute("aria-expanded", String(expanded));
		const label = expanded ? "Collapse this message" : "Expand this message";
		this.options.toggle.title = label;
		this.options.toggle.setAttribute("aria-label", label);
	}
}

/**
 * Copies a rendered prompt body, stripping the hooks that make references
 * clickable. The label's own click scrolls to the message, so a chip inside it
 * must not also try to open its target.
 */
function inertClone(source: PinnedPromptSource): unknown[] {
	const copy = source.cloneNode(true);
	for (const chip of copy.querySelectorAll(
		"[data-resource-uri], [data-workspace-path]",
	)) {
		chip.removeAttribute("data-resource-uri");
		chip.removeAttribute("data-workspace-path");
		chip.removeAttribute("data-workspace-line");
	}
	return [...copy.childNodes];
}
