import type { PiMessage } from "../../shared/protocol.js";

/** A message's slot in the transcript, plus a counter of how often it changed. */
export interface MessageIdentity {
	key: number;
	version: number;
}

/**
 * Carries slot identities across a snapshot boundary.
 *
 * A snapshot re-parses every message, so object identity — which the render
 * signature is built on — is lost for the whole transcript at once. Without
 * adopting it back, the incremental renderer rebuilds every rendered message
 * (markdown parse, sanitize, highlight, node swap) after each turn, and a
 * rebuilt node drops its expanded state, so the reader's open thinking blocks
 * and tool cards close themselves.
 *
 * Messages are paired by content (identical serialization) rather than by
 * position: a snapshot can insert, drop or reorder entries, and pairing by index
 * would then hand one message another's slot. Identical serialization is a
 * deliberately strict test. The render signature does not inspect content — it
 * trusts identity to signal change — so adopting an identity for a message whose
 * content actually changed would leave a stale node on screen. A silently wrong
 * transcript is much worse than a rebuild, so anything short of an exact match is
 * left to rebuild.
 *
 * `version` is copied unchanged rather than bumped, because an unchanged version
 * is what keeps the node's signature stable. (`inheritMessageIdentity` in the
 * webview bumps it deliberately: there the content did change.)
 *
 * Only the tail is examined. Messages further back sit past the render cap and
 * never get a node, so pairing them would spend time for nothing.
 */
export function adoptSnapshotIdentities(options: {
	previous: readonly PiMessage[];
	next: readonly PiMessage[];
	/** How many trailing messages of each array to consider. */
	windowSize: number;
	identityOf: (message: PiMessage) => MessageIdentity | undefined;
	adopt: (message: PiMessage, identity: MessageIdentity) => void;
}): number {
	const { previous, next, windowSize, identityOf, adopt } = options;
	const available = new Map<string, MessageIdentity[]>();
	for (const message of previous.slice(-windowSize)) {
		const identity = identityOf(message);
		if (!identity) continue;
		const serialized = JSON.stringify(message);
		const bucket = available.get(serialized);
		if (bucket) bucket.push(identity);
		else available.set(serialized, [identity]);
	}

	let adopted = 0;
	for (const message of next.slice(-windowSize)) {
		const identity = available.get(JSON.stringify(message))?.shift();
		if (!identity) continue;
		adopt(message, identity);
		adopted += 1;
	}
	return adopted;
}
