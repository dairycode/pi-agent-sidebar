/**
 * Decides whether the transcript should keep following its own bottom edge.
 *
 * Streaming appends content every frame, so "scroll to bottom on new content"
 * has to be conditional or it fights the reader: any upward gesture is undone
 * by the next delta. A distance-from-bottom threshold alone cannot express the
 * difference, because the reader starts every gesture from the bottom — the
 * first few pixels of an upward drag look exactly like sitting still.
 *
 * So intent is tracked explicitly. An upward wheel or touch drag detaches
 * immediately, before any scrolling has happened, and only arriving back at the
 * bottom re-attaches. Dragging the scrollbar produces no wheel or touch event,
 * so scroll events are classified too: a position this controller did not ask
 * for came from the reader.
 */

export interface ScrollAnchorViewport {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

export interface ScrollAnchorOptions {
	viewport: ScrollAnchorViewport;
	/**
	 * How close to the bottom still counts as "at the bottom".
	 *
	 * Kept small on purpose. A generous threshold is what makes short upward
	 * drags snap back, and it is not needed for robustness: sub-pixel layout
	 * rounding is covered by a few pixels, and every larger gap is a deliberate
	 * scroll away from the bottom.
	 */
	bottomThresholdPx?: number;
}

const DEFAULT_BOTTOM_THRESHOLD_PX = 4;

/**
 * Slack allowed when recognising our own scroll position again. Setting
 * `scrollTop` can land on a neighbouring subpixel value, which must not read as
 * a reader-initiated scroll.
 */
const PROGRAMMATIC_TOLERANCE_PX = 1;

export class ScrollAnchor {
	private following = true;
	private expectedScrollTop: number | undefined;
	private readonly bottomThresholdPx: number;

	public constructor(private readonly options: ScrollAnchorOptions) {
		this.bottomThresholdPx =
			options.bottomThresholdPx ?? DEFAULT_BOTTOM_THRESHOLD_PX;
	}

	/** True while new content should pull the viewport down with it. */
	public get isFollowing(): boolean {
		return this.following;
	}

	/**
	 * Reports a reader gesture, in the wheel event's sign convention (negative
	 * scrolls up, towards older messages).
	 *
	 * Upward gestures detach here rather than waiting for the resulting scroll
	 * event, so the very first frame of the gesture is already exempt from
	 * auto-scrolling. Downward gestures are ignored: they are handled by the
	 * bottom check in `noteScroll`, which re-attaches only once the bottom is
	 * actually reached instead of guessing from momentum.
	 */
	public noteUserIntent(deltaY: number): void {
		if (deltaY < 0) this.following = false;
	}

	/**
	 * Re-evaluates following state from an observed scroll position.
	 *
	 * Safe to call on every scroll event: it only reads scroll offsets, which are
	 * already up to date inside a scroll handler and so force no extra layout.
	 */
	public noteScroll(): void {
		const { scrollTop } = this.options.viewport;
		if (this.distanceFromBottom() <= this.bottomThresholdPx) {
			this.following = true;
			this.expectedScrollTop = scrollTop;
			return;
		}
		// Away from the bottom. Our own bottom-pinning scroll can legitimately land
		// here while content is still settling, so only an unexpected position
		// counts as the reader taking over.
		if (
			this.expectedScrollTop !== undefined &&
			Math.abs(scrollTop - this.expectedScrollTop) <= PROGRAMMATIC_TOLERANCE_PX
		) {
			return;
		}
		this.following = false;
	}

	/** Forces following again, for actions that imply "show me the latest". */
	public follow(): void {
		this.following = true;
	}

	/**
	 * Pins the viewport to the bottom when following, and reports whether it did.
	 *
	 * Reads back the applied offset instead of trusting the requested one so a
	 * clamped value still counts as ours in `noteScroll`.
	 */
	public stickToBottomIfFollowing(): boolean {
		if (!this.following) return false;
		const { viewport } = this.options;
		viewport.scrollTop = viewport.scrollHeight;
		this.expectedScrollTop = viewport.scrollTop;
		return true;
	}

	private distanceFromBottom(): number {
		const { scrollHeight, scrollTop, clientHeight } = this.options.viewport;
		return scrollHeight - scrollTop - clientHeight;
	}
}
