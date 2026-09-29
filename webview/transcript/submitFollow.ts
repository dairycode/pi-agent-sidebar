import { contentText } from "../../shared/messageContent.js";
import type { PiMessage } from "../../shared/protocol.js";
import { normalizeEpochMs } from "./messageTime.js";

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

/**
 * Whether a transcript message is the echo of a prompt the reader submitted.
 *
 * A submitted prompt is wrapped before it reaches pi — pi-context, reference
 * blocks — so the message is either the draft itself or ends with it after a
 * blank line. Exported because the snapshot recovery in `main.ts` has to
 * recognise its own submission with the same rule the follow coordinator uses;
 * two copies would drift and one of them would silently stop matching.
 */
export function matchesSubmittedDraft(
	messageText: string,
	draft: string,
): boolean {
	return messageText === draft || messageText.endsWith(`\n\n${draft}`);
}

/**
 * Slack for comparing two clocks: pi's and the webview's.
 *
 * The comparison below compares a pi timestamp against a locally captured one,
 * corrected by the offset the webview measures per snapshot. The tolerance is
 * there for the case where that offset is unknown (a snapshot without
 * `timeContext` leaves it at zero) rather than for the fraction of a second an
 * accepted prompt takes to be appended.
 */
export const SUBMIT_ACK_TIMESTAMP_TOLERANCE_MS = 60_000;

export interface SubmitAcknowledgementOptions {
	draft: string;
	/** Local clock: when this webview asked for the submit. */
	submittedAtMs: number;
	/** `hostNowMs - localNowMs`, as measured from the last snapshot. */
	clockSkewMs: number;
}

/**
 * Whether a snapshot proves pi accepted this submit.
 *
 * The acknowledgement the webview waits for is an `actionResult`, and one lost
 * behind a hidden view left the submit latched with no way back. A snapshot that
 * already carries the submitted prompt proves the same thing, so the same
 * cleanup runs from here.
 *
 * Two conditions, because the text alone is not evidence. Only the newest user
 * message is considered — pi appends the prompt it accepted, so the echo is the
 * last user message in the session — and it has to be stamped at or after the
 * submit. Without the timestamp a repeated prompt would pass: a sentence the
 * reader asked twice, where the first echo is still in the transcript, would
 * mark the second attempt accepted even when pi refused it. An unreadable
 * timestamp is not evidence either.
 */
export function snapshotAcknowledgesSubmit(
	messages: readonly PiMessage[],
	options: SubmitAcknowledgementOptions,
): boolean {
	const newestUserMessage = findNewestUserMessage(messages);
	if (!newestUserMessage) return false;
	if (
		!matchesSubmittedDraft(contentText(newestUserMessage.content), options.draft)
	)
		return false;
	const timestamp = normalizeEpochMs(newestUserMessage.timestamp);
	if (timestamp === undefined) return false;
	const submittedAtHostMs = options.submittedAtMs + options.clockSkewMs;
	return timestamp >= submittedAtHostMs - SUBMIT_ACK_TIMESTAMP_TOLERANCE_MS;
}

function findNewestUserMessage(
	messages: readonly PiMessage[],
): PiMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user") return message;
	}
	return undefined;
}
