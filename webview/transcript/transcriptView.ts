/**
 * Keyed, incremental transcript rendering.
 *
 * The transcript used to be rebuilt wholesale on every render: each message was
 * re-parsed from markdown, re-sanitized, and every node in the scroll container
 * was replaced. During streaming that runs once per frame, and it is the reason
 * scrolling stuttered — the frame budget went to re-rendering history that had
 * not changed, and replacing every node left the browser with no stable node to
 * anchor the scroll position to.
 *
 * This keeps one DOM node per message, keyed by the message's position in the
 * transcript, and only rebuilds a node when its `signature` changes. A streaming
 * reply therefore touches exactly one node per frame and leaves history — the
 * part the reader is scrolled into — physically untouched.
 *
 * Generic over the node type and driven through a small container interface so
 * the reconciliation can be tested without a DOM. Node construction stays with
 * the caller, which owns sanitization and post-processing.
 */

export interface TranscriptEntry {
	/**
	 * Stable identity for this slot, which must not change while the message
	 * stays in the transcript. Reusing a key for a different message shows up as
	 * stale content, and changing a key needlessly rebuilds the node and drops
	 * its expanded/selection state.
	 */
	readonly key: string;
	/** Change marker: an equal signature means the node may be reused as is. */
	readonly signature: string;
}

/**
 * The subset of a parent element this view drives.
 *
 * Returns are declared `void` because the results are never used; the DOM's own
 * `Node`-returning methods still satisfy this structurally.
 */
export interface TranscriptContainer<N> {
	insertBefore(node: N, reference: N | null): void;
	removeChild(node: N): void;
}

export interface TranscriptViewOptions<N> {
	container: TranscriptContainer<N>;
	/**
	 * Builds the node for an entry. `previous` is the node being replaced, when
	 * there is one, so the caller can carry over state that lives in the DOM
	 * rather than in message data (expanded disclosures, for instance).
	 */
	createNode(entry: TranscriptEntry, previous: N | undefined): N;
}

export interface TranscriptUpdateStats {
	/** Nodes built this pass \u2014 the expensive part, and so the useful metric. */
	created: number;
	reused: number;
	removed: number;
	moved: number;
}

interface RenderedEntry<N> {
	node: N;
	signature: string;
}

export class TranscriptView<N> {
	private readonly rendered = new Map<string, RenderedEntry<N>>();
	/** Mirrors the container's child order, so reconciling reads no DOM. */
	private order: string[] = [];

	public constructor(private readonly options: TranscriptViewOptions<N>) {}

	/** The node currently rendered for a key, for callers that need to inspect it. */
	public nodeFor(key: string): N | undefined {
		return this.rendered.get(key)?.node;
	}

	public update(entries: readonly TranscriptEntry[]): TranscriptUpdateStats {
		const stats: TranscriptUpdateStats = {
			created: 0,
			reused: 0,
			removed: 0,
			moved: 0,
		};
		this.removeMissing(entries, stats);

		// Keys still attached, in their current order. Walked with a cursor so the
		// common append-only case performs no moves at all.
		const remaining = this.order.filter((key) => this.rendered.has(key));
		let cursor = 0;
		for (const entry of entries) {
			const wasRendered = this.rendered.has(entry.key);
			const node = this.resolveNode(entry, stats);
			if (remaining[cursor] === entry.key) {
				cursor += 1;
				continue;
			}
			this.place(node, remaining[cursor]);
			// A first insertion is not a move; counting it as one would report an
			// append-only stream as constantly reordering itself.
			if (wasRendered) stats.moved += 1;
		}

		this.order = entries.map((entry) => entry.key);
		return stats;
	}

	/** Detaches nodes whose entries are gone, e.g. history past the render cap. */
	private removeMissing(
		entries: readonly TranscriptEntry[],
		stats: TranscriptUpdateStats,
	): void {
		const desired = new Set(entries.map((entry) => entry.key));
		for (const key of this.order) {
			if (desired.has(key)) continue;
			const existing = this.rendered.get(key);
			if (!existing) continue;
			this.options.container.removeChild(existing.node);
			this.rendered.delete(key);
			stats.removed += 1;
		}
	}

	/**
	 * Returns the node for an entry, reusing it when its signature is unchanged.
	 *
	 * This is where the saving lives: an unchanged signature means no markdown
	 * parse, no sanitize, and no node replacement for that message.
	 */
	private resolveNode(entry: TranscriptEntry, stats: TranscriptUpdateStats): N {
		const existing = this.rendered.get(entry.key);
		if (existing?.signature === entry.signature) {
			stats.reused += 1;
			return existing.node;
		}
		const node = this.options.createNode(entry, existing?.node);
		stats.created += 1;
		if (existing) {
			// Swapping in place leaves the surrounding nodes, and so the reader's
			// scroll position, undisturbed.
			this.options.container.insertBefore(node, existing.node);
			this.options.container.removeChild(existing.node);
		}
		this.rendered.set(entry.key, { node, signature: entry.signature });
		return node;
	}

	/** Moves a node to the slot currently held by `beforeKey`, or to the end. */
	private place(node: N, beforeKey: string | undefined): void {
		const reference = beforeKey
			? (this.rendered.get(beforeKey)?.node ?? null)
			: null;
		this.options.container.insertBefore(node, reference);
	}

	/** Drops all nodes, for a session switch where nothing can be reused. */
	public clear(): void {
		for (const key of this.order) {
			const existing = this.rendered.get(key);
			if (existing) this.options.container.removeChild(existing.node);
		}
		this.rendered.clear();
		this.order = [];
	}
}
