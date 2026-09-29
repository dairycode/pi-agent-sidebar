export interface ComposerFocusInput {
	disabled: boolean;
	focus: (options?: FocusOptions) => void;
}

export interface ComposerFocusRequestOptions {
	input: ComposerFocusInput;
	isInputFocused: () => boolean;
	notifyFocused: (requestId: number) => void;
	requestFrame: (callback: FrameRequestCallback) => number;
}

/** How a newly accepted request should be greeted; `undefined` means it was stale. */
export type ComposerFocusAcceptance = "announce" | "silent" | undefined;

/**
 * Completes one host focus request at a time, in id order.
 *
 * The host waits for a `composerFocused` reply, so an attempt either completes the
 * request it started or schedules another attempt for that same request — it never
 * leaves one pending with nothing left to drive it. Focus can be refused (the
 * webview is hidden, a collapsed sidebar, another surface holding it), which is why
 * the completion is confirmed against the document rather than assumed from the
 * `focus()` call; and a frame scheduled while the webview is hidden simply does not
 * run, so retries cost nothing until the webview is visible again.
 */
export class ComposerFocusRequests {
	private requestId: number | undefined;
	private isAttemptQueued = false;
	private lastAnnouncedId = 0;
	private lastCompletedId = 0;

	public constructor(private readonly options: ComposerFocusRequestOptions) {}

	/**
	 * Registers a request id.
	 *
	 * `"announce"` means the id is newer than anything announced and the caller should
	 * describe what was focused; `"silent"` means it is a repeat of an id already
	 * announced; `undefined` means it is stale — older than a completed request, or
	 * older than the one still pending — and must be ignored.
	 */
	public accept(requestId: number): ComposerFocusAcceptance {
		if (
			!Number.isInteger(requestId) ||
			requestId <= this.lastCompletedId ||
			requestId < (this.requestId ?? 0)
		) {
			return undefined;
		}
		this.requestId = requestId;
		if (requestId <= this.lastAnnouncedId) return "silent";
		this.lastAnnouncedId = requestId;
		return "announce";
	}

	/** Attempts the pending request, on this frame or the next one that can hold it. */
	public attempt(): void {
		const { input, requestFrame } = this.options;
		if (this.requestId === undefined || this.isAttemptQueued || input.disabled)
			return;
		const requestId = this.requestId;
		this.isAttemptQueued = true;
		requestFrame(() => {
			this.isAttemptQueued = false;
			if (this.requestId !== requestId || input.disabled) {
				this.attempt();
				return;
			}
			input.focus({ preventScroll: true });
			// A refused focus is not a completed request: leaving it pending is what
			// lets a later attempt finish it instead of dropping the host's reply.
			if (!this.options.isInputFocused()) return;
			this.lastCompletedId = requestId;
			this.requestId = undefined;
			this.options.notifyFocused(requestId);
		});
	}
}
