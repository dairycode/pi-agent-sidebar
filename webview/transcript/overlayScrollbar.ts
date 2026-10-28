/**
 * Draws the transcript's scrollbar, because the platform's cannot be held to
 * the overlay behaviour the transcript is tuned around.
 *
 * macOS decides overlay versus space-taking per system setting, and the
 * default one flips the moment a mouse is wired: the native scrollbar turns
 * into an always-visible bar that squeezes the column, so the transcript's
 * right rail visibly changes width mid-session depending on which input device
 * is attached. CSS cannot push back — overlay versus classic is the OS's call,
 * and `::-webkit-scrollbar` or `scrollbar-width` styling would only trade the
 * overlay for a custom space-taking scrollbar of our own. Drawing the thumb is
 * the one scrollbar whose behaviour is the page's own, which is the same trade
 * the VS Code workbench makes.
 *
 * The thumb mirrors the platform overlay it replaces: it appears on any scroll
 * (reader or programmatic follow), fades once the scrolling rests, widens
 * under the pointer, and drags. While it is mounted the native scrollbar is
 * hidden (`is-overlay-scrolled`), so the space it would have taken in the
 * mouse's classic mode is never taken at all.
 */

/**
 * Milliseconds of scroll stillness before the thumb starts to fade, and the
 * duration of that fade — lifted from the platform animator this thumb
 * replaces (`kFadeOutDelay` and `kAnimationDuration` in Chromium's
 * `ui/native_theme/scrollbar_animator_mac.h`), so the drawn bar's rhythm is
 * indistinguishable from the native one it stood in for. The one deliberate
 * divergence: hover keeps the thumb up here by the same timer the scroll path
 * uses, where the platform blocks the timer while the mouse is in the track —
 * same observable behaviour, one less knob.
 */
const DEFAULT_HIDE_DELAY_MS = 500;
/** The platform thumb never shrinks past a minimum grab size. */
const THUMB_MIN_PX = 24;
/** Content that fits still rounds up past the exact-fit check by subpixels. */
const FIT_SLACK_PX = 1;

export interface OverlayScrollbarOptions {
	/** The scrolling element whose position the thumb mirrors. */
	viewport: HTMLElement;
	/**
	 * The element whose content overflows the viewport. Its growth repaints
	 * the thumb: content that arrives without a scroll of its own (streaming
	 * under a detached reader) would otherwise leave a visible thumb stale.
	 */
	content: HTMLElement;
	/** The positioned ancestor the thumb strip docks to. */
	frame: HTMLElement;
	hideDelayMs?: number;
	onUserIntent?: (deltaY: number) => void;
	onDragStart?: () => void;
	onDragEnd?: () => void;
}

/**
 * The thumb's geometry for one scroll position, or `undefined` when the
 * content fits and there is nothing to scroll — exported for its own test.
 *
 * The height is the visible fraction of the content clamped to a floor, so a
 * very long transcript still leaves a grabbable thumb; the travel shrinks by
 * the same floor, which is what keeps the endpoints exact: `scrollTop = 0`
 * pins the thumb to the top edge and `scrollTop = hidden` to the bottom one.
 */
export function computeThumbMetrics(
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number,
): { height: number; top: number } | undefined {
	const hidden = scrollHeight - clientHeight;
	if (hidden <= FIT_SLACK_PX) return undefined;
	const height = Math.max(
		THUMB_MIN_PX,
		(clientHeight / scrollHeight) * clientHeight,
	);
	const travel = clientHeight - height;
	const top = Math.min(1, Math.max(0, scrollTop / hidden)) * travel;
	return { height, top };
}

/**
 * Mounts the thumb strip and returns nothing: the transcript outlives the
 * webview, so nothing ever tears it down.
 */
export function mountOverlayScrollbar(options: OverlayScrollbarOptions): void {
	const { viewport, content, frame } = options;
	const hideDelayMs = options.hideDelayMs ?? DEFAULT_HIDE_DELAY_MS;

	const root = document.createElement("div");
	root.className = "transcript-scrollbar";
	const thumb = document.createElement("div");
	thumb.className = "transcript-scrollbar-thumb";
	root.append(thumb);
	frame.append(root);
	// Hides the native scrollbar; set only on a live mount so a module that
	// failed to load never leaves the transcript scrollbar-less.
	viewport.classList.add("is-overlay-scrolled");

	let hideHandle: ReturnType<typeof setTimeout> | undefined;
	let dragPointerId: number | undefined;
	let dragOrigin = { pointerY: 0, scrollTop: 0 };
	let thumbHeight = THUMB_MIN_PX;

	const isDragging = () => dragPointerId !== undefined;

	const scheduleHide = (delayMs: number) => {
		clearTimeout(hideHandle);
		hideHandle = setTimeout(() => {
			if (!isDragging()) root.classList.remove("is-active");
		}, delayMs);
	};

	function paint(): void {
		const metrics = computeThumbMetrics(
			viewport.scrollTop,
			viewport.scrollHeight,
			viewport.clientHeight,
		);
		root.classList.toggle("is-overflowing", metrics !== undefined);
		if (!metrics) return;
		thumbHeight = metrics.height;
		thumb.style.height = `${metrics.height}px`;
		thumb.style.transform = `translateY(${metrics.top}px)`;
	}

	function reveal(delayMs: number): void {
		paint();
		root.classList.add("is-active");
		scheduleHide(delayMs);
	}

	// Follow-the-bottom and reader gestures both land here, which is what makes
	// the thumb behave like the native overlay one: streaming keeps it lit for
	// as long as the viewport keeps moving.
	viewport.addEventListener("scroll", () => reveal(hideDelayMs), {
		passive: true,
	});

	// Content growth alone raises no scroll event, but a lit thumb over changed
	// content must not go stale until the next scroll lands on it.
	const observer = new ResizeObserver(() => paint());
	observer.observe(content);
	observer.observe(viewport);

	// The strip sits over the claimed gutter, outside the scroller, so a wheel
	// over it would scroll nothing — hand the deltas to the viewport the way a
	// native scrollbar does.
	root.addEventListener(
		"wheel",
		(event) => {
			options.onUserIntent?.(event.deltaY);
			viewport.scrollTop += event.deltaY;
		},
		{ passive: true },
	);

	root.addEventListener("pointerenter", () => {
		clearTimeout(hideHandle);
		paint();
		root.classList.add("is-active");
	});
	root.addEventListener("pointerleave", () => {
		if (!isDragging()) scheduleHide(hideDelayMs);
	});

	thumb.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		options.onDragStart?.();
		dragPointerId = event.pointerId;
		dragOrigin = { pointerY: event.clientY, scrollTop: viewport.scrollTop };
		thumb.setPointerCapture(event.pointerId);
		root.classList.add("is-active", "is-dragging");
	});
	thumb.addEventListener("pointermove", (event) => {
		if (event.pointerId !== dragPointerId) return;
		const travel = viewport.clientHeight - thumbHeight;
		if (travel <= 0) return;
		const range = viewport.scrollHeight - viewport.clientHeight;
		const targetScrollTop =
			dragOrigin.scrollTop +
			((event.clientY - dragOrigin.pointerY) / travel) * range;
		options.onUserIntent?.(targetScrollTop - viewport.scrollTop);
		viewport.scrollTop = targetScrollTop;
	});
	const endDrag = (event: PointerEvent) => {
		if (event.pointerId !== dragPointerId) return;
		dragPointerId = undefined;
		root.classList.remove("is-dragging");
		options.onDragEnd?.();
		scheduleHide(hideDelayMs);
	};
	thumb.addEventListener("pointerup", endDrag);
	thumb.addEventListener("pointercancel", endDrag);
	thumb.addEventListener("lostpointercapture", endDrag);

	paint();
}
