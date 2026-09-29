export interface LiveStatusOptions {
	liveStatus: HTMLElement;
	requestFrame: (callback: FrameRequestCallback) => number;
}

/**
 * Announces status sentences through an `aria-live` region.
 *
 * The region is cleared synchronously and filled on the next frame, so repeating
 * the same sentence still counts as a change and is read out again. Everything
 * announced before that frame runs therefore has to travel in the single fill that
 * frame performs: a second fill would replace the first, and a live region only
 * ever reports the value it ends a frame with.
 */
export class LiveStatusAnnouncer {
	private pending: string[] = [];
	private isFillScheduled = false;

	public constructor(private readonly options: LiveStatusOptions) {}

	public announce(message: string): void {
		if (!message) return;
		this.pending.push(message);
		if (this.isFillScheduled) return;
		this.isFillScheduled = true;
		this.options.liveStatus.textContent = "";
		this.options.requestFrame(() => {
			this.isFillScheduled = false;
			const sentences = this.pending;
			this.pending = [];
			this.options.liveStatus.textContent = sentences.join(" ");
		});
	}
}
