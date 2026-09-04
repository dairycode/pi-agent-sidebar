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
	/**
	 * How close to the bottom a scroll that is still moving downwards counts as
	 * "returning to the bottom".
	 *
	 * The last inertial tick of a return-to-bottom can land a few pixels short
	 * of {@link bottomThresholdPx} while streaming keeps growing the content,
	 * and with no further scroll event ever arriving that state would stick
	 * forever. This window re-attaches such a scroll, but only while it is
	 * still moving towards the bottom: an upward drag keeps the strict line
	 * alone, so a short upward gesture is never snapped back mid-flight.
	 */
	attachWindowPx?: number;
	requestFrame?: (callback: FrameRequestCallback) => number;
	cancelFrame?: (handle: number) => void;
	shouldAnimate?: () => boolean;
}

const DEFAULT_BOTTOM_THRESHOLD_PX = 4;
const DEFAULT_ATTACH_WINDOW_PX = 24;
const DEFAULT_FRAME_DURATION_MS = 1000 / 60;
const MAX_FRAME_DURATION_MS = 50;
const SMOOTH_SCROLL_TIME_CONSTANT_MS = 80;
const SMOOTH_SCROLL_SETTLE_PX = 0.5;

/**
 * Slack allowed when recognising our own scroll position again. Setting
 * `scrollTop` can land on a neighbouring subpixel value, which must not read as
 * a reader-initiated scroll.
 */
const PROGRAMMATIC_TOLERANCE_PX = 1;

export class ScrollAnchor {
	private following = true;
	private expectedScrollTop: number | undefined;
	private animationFrame: number | undefined;
	private animationTargetScrollTop: number | undefined;
	private previousFrameTime: number | undefined;
	private lastDistanceFromBottom: number | undefined;
	private readonly bottomThresholdPx: number;
	private readonly attachWindowPx: number;

	public constructor(private readonly options: ScrollAnchorOptions) {
		this.bottomThresholdPx =
			options.bottomThresholdPx ?? DEFAULT_BOTTOM_THRESHOLD_PX;
		this.attachWindowPx = options.attachWindowPx ?? DEFAULT_ATTACH_WINDOW_PX;
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
		if (deltaY >= 0) return;
		this.following = false;
		this.cancelAnimation();
	}

	/**
	 * Re-evaluates following state from an observed scroll position.
	 *
	 * Safe to call on every scroll event: it only reads scroll offsets, which are
	 * already up to date inside a scroll handler and so force no extra layout.
	 */
	public noteScroll(): void {
		const { scrollTop } = this.options.viewport;
		const distanceFromBottom = this.distanceFromBottom();
		const previousDistanceFromBottom = this.lastDistanceFromBottom;
		this.lastDistanceFromBottom = distanceFromBottom;

		// A programmatic assignment can dispatch its scroll event after an upward
		// gesture has already cancelled the animation. Classify it before any
		// re-attachment rule so that stale event cannot undo the reader's intent.
		if (this.isAtExpectedScrollTop(scrollTop)) return;
		if (distanceFromBottom <= this.bottomThresholdPx) {
			this.following = true;
			this.expectedScrollTop = scrollTop;
			if (distanceFromBottom <= SMOOTH_SCROLL_SETTLE_PX) {
				this.cancelAnimation();
			}
			return;
		}
		// A return-to-bottom can land in the attach window on its final inertial
		// tick even though it is still short of the strict bottom line — and when
		// streaming keeps growing the content, no further scroll event ever
		// arrives, so the detached state would stick forever. Compare bottom
		// distance rather than scrollTop: overflow anchoring can increase scrollTop
		// while preserving the reader's exact visual position.
		const scrollingTowardBottom =
			previousDistanceFromBottom !== undefined &&
			distanceFromBottom < previousDistanceFromBottom;
		if (
			!this.following &&
			scrollingTowardBottom &&
			distanceFromBottom <= this.attachWindowPx
		) {
			this.following = true;
			this.expectedScrollTop = scrollTop;
			return;
		}
		this.following = false;
		this.cancelAnimation();
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
		const targetScrollTop = Math.max(
			0,
			viewport.scrollHeight - viewport.clientHeight,
		);
		if (
			this.canAnimate() &&
			targetScrollTop - viewport.scrollTop > SMOOTH_SCROLL_SETTLE_PX
		) {
			this.animationTargetScrollTop = targetScrollTop;
			this.expectedScrollTop = viewport.scrollTop;
			this.scheduleAnimationFrame();
			return true;
		}

		this.cancelAnimation();
		viewport.scrollTop = viewport.scrollHeight;
		this.expectedScrollTop = viewport.scrollTop;
		return true;
	}

	private canAnimate(): boolean {
		return Boolean(
			this.options.requestFrame &&
				this.options.cancelFrame &&
				(this.options.shouldAnimate?.() ?? true),
		);
	}

	private scheduleAnimationFrame(): void {
		if (this.animationFrame !== undefined) return;
		this.animationFrame = this.options.requestFrame?.(this.stepAnimation);
	}

	private readonly stepAnimation: FrameRequestCallback = (timestamp) => {
		this.animationFrame = undefined;
		const targetScrollTop = this.animationTargetScrollTop;
		if (!this.following || targetScrollTop === undefined) return;

		const { viewport } = this.options;
		if (!this.isAtExpectedScrollTop(viewport.scrollTop)) {
			this.following = false;
			this.cancelAnimation();
			return;
		}

		const frameDuration = Math.min(
			this.previousFrameTime === undefined
				? DEFAULT_FRAME_DURATION_MS
				: timestamp - this.previousFrameTime,
			MAX_FRAME_DURATION_MS,
		);
		this.previousFrameTime = timestamp;
		const progress =
			1 - Math.exp(-frameDuration / SMOOTH_SCROLL_TIME_CONSTANT_MS);
		const remaining = targetScrollTop - viewport.scrollTop;
		viewport.scrollTop =
			remaining <= SMOOTH_SCROLL_SETTLE_PX
				? targetScrollTop
				: viewport.scrollTop + remaining * progress;
		this.expectedScrollTop = viewport.scrollTop;

		if (targetScrollTop - viewport.scrollTop <= SMOOTH_SCROLL_SETTLE_PX) {
			viewport.scrollTop = targetScrollTop;
			this.expectedScrollTop = viewport.scrollTop;
			this.cancelAnimation();
			return;
		}
		this.scheduleAnimationFrame();
	};

	private cancelAnimation(): void {
		if (this.animationFrame !== undefined) {
			this.options.cancelFrame?.(this.animationFrame);
		}
		this.animationFrame = undefined;
		this.animationTargetScrollTop = undefined;
		this.previousFrameTime = undefined;
	}

	private isAtExpectedScrollTop(scrollTop: number): boolean {
		return (
			this.expectedScrollTop !== undefined &&
			Math.abs(scrollTop - this.expectedScrollTop) <= PROGRAMMATIC_TOLERANCE_PX
		);
	}

	private distanceFromBottom(): number {
		const { scrollHeight, scrollTop, clientHeight } = this.options.viewport;
		return scrollHeight - scrollTop - clientHeight;
	}
}
