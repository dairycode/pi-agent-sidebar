/**
 * Stages a big transcript's first build across frames.
 *
 * A fresh build of a full window (first snapshot, session switch) used to
 * construct every message node in one pass — one hundred-plus markdown parses,
 * sanitizations, and highlights in a single frame, which the reader sees as a
 * blank beat before the transcript appears. The tail is what the reader
 * actually lands on, so that is what the first pass renders; the rest backfills
 * a window-worth at a time, one frame apart, above the fold.
 *
 * The staging state lives here rather than in the caller so the policy — when
 * to stage, how much per pass, when it is done — can be tested without a DOM.
 */
export interface ProgressiveWindowOptions {
	/** Windows at or below this size build in one pass; staging is not worth it. */
	threshold: number;
	/** Messages the first pass renders when it stages. */
	initial: number;
	/** Messages each backfill pass adds to the window. */
	chunk: number;
}

export class ProgressiveWindow {
	private staged = 0;

	public constructor(private readonly options: ProgressiveWindowOptions) {}

	/**
	 * Returns the slice of `items` this pass should render.
	 *
	 * `freshBuild` says the view currently holds nothing — a session switch or
	 * first snapshot — which is the only moment staging arms. The window is
	 * always a suffix: backfill inserts above the fold, so a reader sitting at
	 * the bottom (where a fresh build leaves them) never sees the transcript
	 * move under them.
	 */
	public window<T>(items: readonly T[], freshBuild: boolean): readonly T[] {
		if (items.length <= this.options.threshold) {
			this.staged = 0;
			return items;
		}
		if (freshBuild) {
			this.staged = Math.min(this.options.initial, items.length);
		}
		if (this.staged <= 0 || this.staged >= items.length) {
			this.staged = 0;
			return items;
		}
		const window = items.slice(-this.staged);
		this.staged = Math.min(items.length, this.staged + this.options.chunk);
		return window;
	}
}
