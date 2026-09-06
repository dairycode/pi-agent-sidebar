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
	private lastScrollTop: number | undefined;
	private readerControlsViewport = false;
	private readerReachedBottom = false;
	private readerScrollDirection: -1 | 0 | 1 = 0;
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

	/** True while native user scrolling exclusively owns scrollTop. */
	public get isReaderScrolling(): boolean {
		return this.readerControlsViewport;
	}

	/**
	 * Reports a reader gesture, in the wheel event's sign convention (negative
	 * scrolls up, towards older messages).
	 *
	 * Upward gestures detach here rather than waiting for the resulting scroll
	 * event, so the very first frame of the gesture is already exempt from
	 * auto-scrolling. A downward gesture records the direction but does not
	 * re-attach by itself: `noteScroll` still waits until the viewport reaches the
	 * bottom window. Keeping that direction lets native inertia win over content
	 * growth during the handoff.
	 */
	public noteUserIntent(deltaY: number): boolean {
		if (deltaY === 0) return false;
		// A downward wheel/touch gesture at an already-followed bottom cannot move
		// the native viewport. Detaching here would let streaming content drift for
		// the debounce interval and create a visible catch-up pause for no reason.
		if (
			deltaY > 0 &&
			this.following &&
			!this.readerControlsViewport &&
			this.distanceFromBottom() <= this.bottomThresholdPx
		) {
			return false;
		}
		this.readerControlsViewport = true;
		this.readerScrollDirection = deltaY > 0 ? 1 : -1;
		if (deltaY < 0) this.readerReachedBottom = false;
		else if (this.distanceFromBottom() <= this.bottomThresholdPx) {
			this.readerReachedBottom = true;
		}
		this.following = false;
		this.cancelAnimation();
		return true;
	}

	/**
	 * Re-evaluates following state from an observed scroll position.
	 *
	 * Safe to call on every scroll event: it only reads scroll offsets, which are
	 * already up to date inside a scroll handler and so force no extra layout.
	 */
	public noteScroll(): boolean {
		const { scrollTop } = this.options.viewport;
		const distanceFromBottom = this.distanceFromBottom();
		const previousDistanceFromBottom = this.lastDistanceFromBottom;
		const previousScrollTop = this.lastScrollTop;
		this.lastDistanceFromBottom = distanceFromBottom;
		this.lastScrollTop = scrollTop;

		// A delayed event from our own assignment must not steal ownership after a
		// newer gesture. The explicit gesture state remains intact for its debounce.
		if (this.isAtExpectedScrollTop(scrollTop)) {
			return this.readerControlsViewport;
		}

		if (this.readerControlsViewport) {
			const distanceChanged =
				previousDistanceFromBottom === undefined ||
				Math.abs(distanceFromBottom - previousDistanceFromBottom) >
					PROGRAMMATIC_TOLERANCE_PX;
			if (
				distanceChanged &&
				previousScrollTop !== undefined &&
				scrollTop !== previousScrollTop
			) {
				this.readerScrollDirection = scrollTop > previousScrollTop ? 1 : -1;
				if (scrollTop < previousScrollTop) this.readerReachedBottom = false;
			}
			if (distanceFromBottom <= this.bottomThresholdPx) {
				this.readerReachedBottom = true;
			}
			this.following = false;
			this.cancelAnimation();
			// Overflow anchoring raises scrollTop by exactly the content growth while
			// preserving bottom distance. It is not continued reader motion and must
			// not keep resetting the native-scroll settle timer during a long stream.
			return distanceChanged;
		}

		// Scrollbar drags and keyboard scrolling have no wheel/touch intent event.
		// Every unexpected offset, including a direct drag onto the bottom line,
		// starts an exclusive reader-owned phase. Re-attaching inside this event
		// would race a thumb still being dragged or native momentum still running.
		this.readerControlsViewport = true;
		this.readerReachedBottom = distanceFromBottom <= this.bottomThresholdPx;
		this.readerScrollDirection =
			previousScrollTop === undefined || scrollTop === previousScrollTop
				? this.readerReachedBottom
					? 1
					: 0
				: scrollTop > previousScrollTop
					? 1
					: -1;
		this.following = false;
		this.cancelAnimation();
		return true;
	}

	/**
	 * Ends the debounced native-scroll phase and reports whether following resumed.
	 * Content may have grown after the reader touched the bottom, so reaching it
	 * at any point during a downward gesture is enough to hand ownership back.
	 */
	public finishUserScroll(): boolean {
		if (!this.readerControlsViewport) return false;
		const shouldFollow =
			this.readerScrollDirection > 0 &&
			(this.readerReachedBottom ||
				this.distanceFromBottom() <= this.attachWindowPx);
		this.readerControlsViewport = false;
		this.readerReachedBottom = false;
		this.readerScrollDirection = 0;
		if (!shouldFollow) return false;
		this.following = true;
		this.expectedScrollTop = this.options.viewport.scrollTop;
		return true;
	}

	/** Detaches for a local layout change without starting native-scroll ownership. */
	public detach(): void {
		this.readerControlsViewport = false;
		this.readerReachedBottom = false;
		this.readerScrollDirection = 0;
		this.following = false;
		this.cancelAnimation();
	}

	/** Forces following again, for actions that imply "show me the latest". */
	public follow(): void {
		this.readerControlsViewport = false;
		this.readerReachedBottom = false;
		this.readerScrollDirection = 0;
		this.following = true;
		this.cancelAnimation();
		this.expectedScrollTop = undefined;
		this.lastDistanceFromBottom = undefined;
		this.lastScrollTop = undefined;
	}

	/**
	 * Pins the viewport to the bottom when following, and reports whether it did.
	 *
	 * Reads back the applied offset instead of trusting the requested one so a
	 * clamped value still counts as ours in `noteScroll`.
	 */
	public stickToBottomIfFollowing(): boolean {
		const { viewport } = this.options;
		const targetScrollTop = Math.max(
			0,
			viewport.scrollHeight - viewport.clientHeight,
		);
		if (!this.following) return false;
		if (
			this.canAnimate() &&
			targetScrollTop - viewport.scrollTop > SMOOTH_SCROLL_SETTLE_PX
		) {
			const isStartingAnimation = this.animationTargetScrollTop === undefined;
			this.animationTargetScrollTop = targetScrollTop;
			this.expectedScrollTop = viewport.scrollTop;
			// render() has already grown the transcript in this animation frame. If
			// following only schedules another rAF, the newly attached viewport stays
			// visibly still for one paint while its bottom moves away. Advance once
			// when starting, then let rAF continue and retarget the same motion.
			if (
				isStartingAnimation &&
				this.advanceAnimation(DEFAULT_FRAME_DURATION_MS)
			) {
				return true;
			}
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
		if (this.advanceAnimation(frameDuration)) return;
		this.scheduleAnimationFrame();
	};

	/** Advances toward the current target and reports whether it settled. */
	private advanceAnimation(frameDuration: number): boolean {
		const targetScrollTop = this.animationTargetScrollTop;
		if (targetScrollTop === undefined) return true;
		const { viewport } = this.options;
		const remaining = targetScrollTop - viewport.scrollTop;
		if (remaining <= 0) {
			this.expectedScrollTop = viewport.scrollTop;
			this.cancelAnimation();
			return true;
		}
		const progress =
			1 - Math.exp(-frameDuration / SMOOTH_SCROLL_TIME_CONSTANT_MS);
		viewport.scrollTop += remaining * progress;
		this.expectedScrollTop = viewport.scrollTop;

		if (targetScrollTop - viewport.scrollTop > SMOOTH_SCROLL_SETTLE_PX) {
			return false;
		}
		viewport.scrollTop = targetScrollTop;
		this.expectedScrollTop = viewport.scrollTop;
		this.cancelAnimation();
		return true;
	}

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
