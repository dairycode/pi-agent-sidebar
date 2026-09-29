import type { HostToWebviewMessage } from "../../shared/protocol.js";

/**
 * Cap on replies held for a hidden view.
 *
 * Reached only when a great many commands are issued while the sidebar is
 * collapsed. Dropping the oldest keeps the newest answers, which are the ones a
 * webview that is now visible is still waiting for.
 */
export const MAX_MISSED_REPLIES = 32;

/**
 * Whether the webview is owed this message and cannot recover without it.
 *
 * `actionResult` is the sharp case: the webview clears its submit latch only
 * there, so a dropped result leaves Enter dead and the send button disabled
 * until the webview reloads. `mediaResolved` leaves the picture blank for the
 * rest of the session, because the webview never asks twice for the same path.
 *
 * Every other reply can be asked for again by reopening the panel that asked
 * (`sessionList`, `forkCandidates`, `commandList`, `workspaceFileList`), and a
 * snapshot is rebuilt on reveal anyway, so none of them are queued.
 */
export function isReplayableReply(message: HostToWebviewMessage): boolean {
 return message.type === "actionResult" || message.type === "mediaResolved";
}

/**
 * Bounded FIFO of replies a hidden view refused, replayed when it is visible
 * again.
 *
 * The editor refuses to deliver messages to a hidden view even with
 * `retainContextWhenHidden` set, and the webview cannot tell a refused message
 * from one still in flight — so a reply that is not replayed is a reply the
 * webview waits for forever.
 */
export class MissedReplyQueue {
 private replies: HostToWebviewMessage[] = [];

 /** Returns the reply dropped to stay within the cap, if any. */
 public push(message: HostToWebviewMessage): HostToWebviewMessage | undefined {
  const dropped =
   this.replies.length >= MAX_MISSED_REPLIES ? this.replies.shift() : undefined;
  this.replies.push(message);
  return dropped;
 }

 /** Takes everything queued, leaving the queue empty. */
 public drain(): HostToWebviewMessage[] {
  const pending = this.replies;
  this.replies = [];
  return pending;
 }
}
