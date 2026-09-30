import type { PiMessage } from "../../shared/protocol.js";

/**
 * Places the in-flight reply back at its own position in the transcript order.
 *
 * pi keeps the reply it is streaming *out* of `state.messages` and appends
 * accepted messages as soon as it has them, so a drained follow-up (or a
 * steering message) can be listed while the reply it followed is still
 * revealing its buffered tail. Appending the live reply as usual would then put
 * the fresh bubble above an answer the reader is still watching, and only the
 * next snapshot would move it back. `index` is where the reply sat when it
 * started — exactly ahead of everything pi delivered while it streamed.
 *
 * A snapshot that lists the reply already put it in pi's order — resume or
 * settle — so the list is handed back unchanged, wherever the recorded index
 * happens to point now.
 */
export function withLiveReply(
	messages: readonly PiMessage[],
	live: PiMessage | undefined,
	index: number,
): readonly PiMessage[] {
	if (!live || messages.includes(live)) return messages;
	const at = Math.min(Math.max(index, 0), messages.length);
	return [...messages.slice(0, at), live, ...messages.slice(at)];
}

/**
 * Inserts a settled reply at `index`, so anything pi delivered while it was
 * being revealed stays after it.
 *
 * Identity is checked first: a snapshot may have listed the message already, and
 * the list pi sent is authoritative.
 */
export function insertReply(
	messages: PiMessage[],
	reply: PiMessage,
	index: number,
): void {
	if (messages.includes(reply)) return;
	messages.splice(Math.min(Math.max(index, 0), messages.length), 0, reply);
}
