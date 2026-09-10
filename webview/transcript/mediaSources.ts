import {
	MAX_PATH_LENGTH,
	MAX_RESOLVE_MEDIA_SOURCES,
} from "../../shared/protocol.js";

export interface ResolvedMediaSource {
	source: string;
	uri: string;
}

/**
 * The host's answers for every image path the transcript has shown.
 *
 * A streaming message is re-rendered on each delta, so the same path is asked
 * for again and again; this cache is what keeps that to one round trip per path.
 * A refused path is remembered too, so a transcript naming a file the sidebar
 * may not load costs one message instead of one per frame. Refusals are dropped
 * when the session changes, because the file a path names may exist by then.
 */
export class MediaSources {
	private readonly uris = new Map<string, string>();
	private readonly refused = new Set<string>();
	private readonly pending = new Map<number, readonly string[]>();
	// Seeded from the clock so a reply meant for the *previous* page load — a
	// resolution still in flight when the webview reloaded — cannot land on a batch
	// of this one, which would otherwise reuse the same small ids.
	private nextRequestId = Date.now();

	public constructor(
		private readonly requestBatch: (requestId: number, sources: string[]) => void,
	) {}

	public uriFor(source: string): string | undefined {
		return this.uris.get(source);
	}

	public isRefused(source: string): boolean {
		return this.refused.has(source);
	}

	/**
	 * Forgets which paths were refused, keeping the answers that are still valid.
	 *
	 * Called when the session changes: a path refused there and then may name a file
	 * that exists later, and a picture the reader never gets back is worse than the
	 * one round trip this costs.
	 */
	public clearRefusals(): void {
		this.refused.clear();
	}

	/**
	 * Asks about every source still unanswered, split by the protocol's ceiling.
	 *
	 * Returns the sources refused without asking, so the caller can render them
	 * right away instead of leaving them invisible until the next pass.
	 */
	public request(sources: readonly string[]): string[] {
		const fresh: string[] = [];
		const refused: string[] = [];
		for (const source of new Set(sources)) {
			if (source.length > MAX_PATH_LENGTH) {
				// Too long to survive the parser, which drops the whole message over one
				// such entry: asking would strand this source's batch mates as well, and the
				// host could only refuse it anyway.
				this.refused.add(source);
				refused.push(source);
				continue;
			}
			if (this.isUnanswered(source)) fresh.push(source);
		}
		for (
			let index = 0;
			index < fresh.length;
			index += MAX_RESOLVE_MEDIA_SOURCES
		) {
			const batch = fresh.slice(index, index + MAX_RESOLVE_MEDIA_SOURCES);
			const requestId = this.nextRequestId++;
			this.pending.set(requestId, batch);
			this.requestBatch(requestId, batch);
		}
		return refused;
	}

	/**
	 * Applies one reply and reports which sources changed state, so the caller
	 * only walks the DOM when something can actually change on screen.
	 */
	public applyResolved(
		requestId: number,
		resolved: readonly ResolvedMediaSource[],
	): string[] {
		const batch = this.pending.get(requestId);
		// A reply to a batch this instance never sent (a replaced view, a reloaded
		// webview) is not evidence about any source.
		if (!batch) return [];
		this.pending.delete(requestId);

		const answered = new Set(resolved.map((entry) => entry.source));
		const changed: string[] = [];
		for (const entry of resolved) {
			if (!batch.includes(entry.source)) continue;
			if (this.uris.get(entry.source) === entry.uri) continue;
			this.uris.set(entry.source, entry.uri);
			changed.push(entry.source);
		}
		// Anything the host left out of the reply is refused, not pending: this is
		// the only place that decides a path will never render.
		for (const source of batch) {
			if (answered.has(source) || this.uris.has(source)) continue;
			this.refused.add(source);
			changed.push(source);
		}
		return changed;
	}

	private isUnanswered(source: string): boolean {
		if (this.uris.has(source) || this.refused.has(source)) return false;
		for (const batch of this.pending.values()) {
			if (batch.includes(source)) return false;
		}
		return true;
	}
}
