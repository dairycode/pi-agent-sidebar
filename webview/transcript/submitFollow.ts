export interface SubmitFollowOptions {
	onFollow: () => void;
	now?: () => number;
	expiryMs?: number;
}

interface PendingSubmitFollow {
	draft: string;
	inputHeight: number;
	startedAt: number;
	userMessageArrived: boolean;
	actionSettled: boolean;
	awaitingComposerResize: boolean;
}

const DEFAULT_EXPIRY_MS = 5 * 60_000;
const HEIGHT_TOLERANCE_PX = 0.5;

/** Keeps an explicit send attached across independent message and composer updates. */
export class SubmitFollowCoordinator {
	private readonly pending = new Map<string, PendingSubmitFollow>();
	private readonly now: () => number;
	private readonly expiryMs: number;

	public constructor(private readonly options: SubmitFollowOptions) {
		this.now = options.now ?? Date.now;
		this.expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS;
	}

	public start(actionId: string, draft: string, inputHeight: number): void {
		// The UI permits only one in-flight submit. A new explicit send supersedes
		// an older lock whose pi version may never have emitted a user echo.
		this.pending.clear();
		this.pending.set(actionId, {
			draft,
			inputHeight,
			startedAt: this.now(),
			userMessageArrived: false,
			actionSettled: false,
			awaitingComposerResize: false,
		});
	}

	public settleAction(
		actionId: string,
		succeeded: boolean,
		inputHeight: number,
	): void {
		this.removeExpired();
		const pending = this.pending.get(actionId);
		if (!pending) return;
		if (!succeeded) {
			this.pending.delete(actionId);
			return;
		}
		pending.actionSettled = true;
		pending.awaitingComposerResize =
			inputHeight < pending.inputHeight - HEIGHT_TOLERANCE_PX;
		this.options.onFollow();
		this.removeIfComplete(actionId, pending);
	}

	public noteUserMessage(messageText: string): boolean {
		this.removeExpired();
		for (const [actionId, pending] of this.pending) {
			if (!matchesSubmittedDraft(messageText, pending.draft)) continue;
			pending.userMessageArrived = true;
			this.options.onFollow();
			this.removeIfComplete(actionId, pending);
			return true;
		}
		return false;
	}

	public noteComposerResize(): boolean {
		let shouldFollow = false;
		for (const [actionId, pending] of this.pending) {
			if (!pending.actionSettled || !pending.awaitingComposerResize) continue;
			pending.awaitingComposerResize = false;
			shouldFollow = true;
			this.removeIfComplete(actionId, pending);
		}
		if (shouldFollow) this.options.onFollow();
		return shouldFollow;
	}

	public cancelAll(): void {
		this.pending.clear();
	}

	private removeExpired(): void {
		const now = this.now();
		for (const [actionId, pending] of this.pending) {
			if (now - pending.startedAt > this.expiryMs) this.pending.delete(actionId);
		}
	}

	private removeIfComplete(
		actionId: string,
		pending: PendingSubmitFollow,
	): void {
		if (
			pending.userMessageArrived &&
			pending.actionSettled &&
			!pending.awaitingComposerResize
		) {
			this.pending.delete(actionId);
		}
	}
}

function matchesSubmittedDraft(messageText: string, draft: string): boolean {
	return messageText === draft || messageText.endsWith(`\n\n${draft}`);
}
