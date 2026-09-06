interface FrameTask {
	handle: number;
	callback: FrameRequestCallback;
	isCancelled: boolean;
}

export interface FrameCoordinatorOptions {
	requestFrame: (callback: FrameRequestCallback) => number;
	cancelFrame: (handle: number) => void;
	measure: () => void;
	advance?: (timestamp: number) => boolean;
	render: () => void;
	renderAdvance?: () => void;
}

/**
 * Runs transcript measurement, rendering, and scrolling in one native frame.
 *
 * Layout reads happen before streaming DOM writes, then an already queued scroll
 * step runs against the newly rendered height. A task requested by a later phase
 * belongs to the next frame, matching requestAnimationFrame semantics and
 * preventing a write followed by a forced synchronous layout in the same frame.
 */
export class FrameCoordinator {
	private nativeFrame: number | undefined;
	private isMeasurePending = false;
	private isAdvancePending = false;
	private isTranscriptRenderPending = false;
	private isRenderPending = false;
	private pendingScrollTask: FrameTask | undefined;
	private currentScrollTask: FrameTask | undefined;
	private nextScrollHandle = 0;

	public constructor(private readonly options: FrameCoordinatorOptions) {}

	public scheduleMeasure(): void {
		this.isMeasurePending = true;
		this.scheduleNativeFrame();
	}

	public scheduleRender(): void {
		this.isRenderPending = true;
		this.scheduleNativeFrame();
	}

	public scheduleAdvance(): void {
		this.isAdvancePending = true;
		this.scheduleNativeFrame();
	}

	public scheduleTranscriptRender(): void {
		this.isTranscriptRenderPending = true;
		this.scheduleNativeFrame();
	}

	public requestScrollFrame(callback: FrameRequestCallback): number {
		this.nextScrollHandle += 1;
		const task: FrameTask = {
			handle: this.nextScrollHandle,
			callback,
			isCancelled: false,
		};
		this.pendingScrollTask = task;
		this.scheduleNativeFrame();
		return task.handle;
	}

	public cancelScrollFrame(handle: number): void {
		if (this.pendingScrollTask?.handle === handle) {
			this.pendingScrollTask = undefined;
		}
		if (this.currentScrollTask?.handle === handle) {
			this.currentScrollTask.isCancelled = true;
		}
		if (
			!this.isMeasurePending &&
			!this.isAdvancePending &&
			!this.isTranscriptRenderPending &&
			!this.isRenderPending &&
			!this.pendingScrollTask
		) {
			this.cancelNativeFrame();
		}
	}

	private scheduleNativeFrame(): void {
		if (this.nativeFrame !== undefined) return;
		this.nativeFrame = this.options.requestFrame(this.flush);
	}

	private cancelNativeFrame(): void {
		if (this.nativeFrame === undefined) return;
		this.options.cancelFrame(this.nativeFrame);
		this.nativeFrame = undefined;
	}

	private readonly flush: FrameRequestCallback = (timestamp) => {
		this.nativeFrame = undefined;
		// Capture before running any phase. Work requested by a later phase belongs
		// to the next browser frame rather than running after its own DOM writes.
		const shouldMeasure = this.isMeasurePending;
		this.isMeasurePending = false;
		const shouldAdvance = this.isAdvancePending;
		this.isAdvancePending = false;
		const shouldRenderTranscript = this.isTranscriptRenderPending;
		this.isTranscriptRenderPending = false;
		const shouldRender = this.isRenderPending;
		this.isRenderPending = false;
		this.currentScrollTask = this.pendingScrollTask;
		this.pendingScrollTask = undefined;

		if (shouldMeasure) this.options.measure();
		let didAdvance = false;
		if (shouldAdvance && this.options.advance) {
			didAdvance = true;
			if (this.options.advance(timestamp)) this.scheduleAdvance();
		}
		if (shouldRender) this.options.render();
		else if (didAdvance || shouldRenderTranscript) {
			(this.options.renderAdvance ?? this.options.render)();
		}

		const task = this.currentScrollTask;
		this.currentScrollTask = undefined;
		if (task && !task.isCancelled) task.callback(timestamp);
	};
}
