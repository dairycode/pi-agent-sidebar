import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

/**
 * Snapshot adoption has one job: keep the render signature stable for messages
 * whose content did not change, and leave it changed for messages whose content
 * did. The second half is the one that matters — the render signature does not
 * inspect content (it trusts identity to signal change), so adopting an identity
 * across a real content change would leave a stale node on screen with no error
 * anywhere. The wiring tests below therefore run through
 * `messageRenderSignature` itself rather than only checking the returned count.
 */
async function loadIdentity() {
	return loadBundledModule({
		entry: "webview/transcript/messageIdentity.ts",
		name: "message-identity",
		platform: "browser",
	});
}

async function loadRenderer() {
	return loadBundledModule({
		entry: "webview/transcript/renderer.ts",
		name: "message-identity-signature",
		platform: "browser",
		plugins: [
			{
				name: "mock-dompurify",
				setup(buildApi) {
					buildApi.onResolve({ filter: /^dompurify$/ }, () => ({
						path: "dompurify",
						namespace: "mock-dompurify",
					}));
					buildApi.onLoad(
						{ filter: /^dompurify$/, namespace: "mock-dompurify" },
						() => ({
							loader: "js",
							contents: "export default { sanitize: (value) => String(value) };",
						}),
					);
				},
			},
		],
	});
}

async function loadTranscriptView() {
	return loadBundledModule({
		entry: "webview/transcript/transcriptView.ts",
		name: "message-identity-view",
		platform: "browser",
	});
}

/** A stand-in for the webview's `messageIdentities` WeakMap. */
function identityStore() {
	const identities = new WeakMap();
	let nextKey = 0;
	return {
		get: (message) => identities.get(message),
		ensure(message) {
			const existing = identities.get(message);
			if (existing) return existing;
			nextKey += 1;
			const identity = { key: nextKey, version: 0 };
			identities.set(message, identity);
			return identity;
		},
		adopt: (message, identity) => identities.set(message, { ...identity }),
		/** The `identityOf` string `messageRenderSignature` consumes. */
		describe: (message) => {
			const identity = identities.get(message);
			return identity ? `${identity.key}.${identity.version}` : "unkeyed";
		},
	};
}

function userMessage(text, timestamp) {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

/** A fresh array of new objects holding the same data, as a re-parse produces. */
function reparsed(messages) {
	return JSON.parse(JSON.stringify(messages));
}

test("an unchanged snapshot reproduces the render signature exactly", async () => {
	const identity = await loadIdentity();
	const renderer = await loadRenderer();
	try {
		const store = identityStore();
		const previous = [userMessage("first", 1), userMessage("second", 2)];
		previous.forEach(store.ensure);
		const before = previous.map((message) =>
			renderer.module.messageRenderSignature(
				message,
				new Map(),
				new Map(),
				false,
				store.describe,
			),
		);

		const next = reparsed(previous);
		const adopted = identity.module.adoptSnapshotIdentities({
			previous,
			next,
			windowSize: 10,
			identityOf: store.get,
			adopt: store.adopt,
		});

		assert.equal(adopted, 2);
		assert.deepEqual(
			next.map((message) =>
				renderer.module.messageRenderSignature(
					message,
					new Map(),
					new Map(),
					false,
					store.describe,
				),
			),
			before,
		);
	} finally {
		await identity.dispose();
		await renderer.dispose();
	}
});

test("a changed message is left to rebuild", async () => {
	const identity = await loadIdentity();
	const renderer = await loadRenderer();
	try {
		const store = identityStore();
		const previous = [userMessage("first", 1), userMessage("second", 2)];
		previous.forEach(store.ensure);

		const next = reparsed(previous);
		next[1].content = [{ type: "text", text: "second, edited" }];
		const adopted = identity.module.adoptSnapshotIdentities({
			previous,
			next,
			windowSize: 10,
			identityOf: store.get,
			adopt: store.adopt,
		});

		// Only the untouched message keeps its identity; the edited one gets a fresh
		// key, so its signature changes and the node is rebuilt.
		assert.equal(adopted, 1);
		assert.equal(store.describe(next[0]), "1.0");
		assert.equal(store.get(next[1]), undefined);
	} finally {
		await identity.dispose();
		await renderer.dispose();
	}
});

test("appended messages do not disturb the identity of earlier ones", async () => {
	const identity = await loadIdentity();
	try {
		const store = identityStore();
		const previous = [userMessage("first", 1), userMessage("second", 2)];
		previous.forEach(store.ensure);

		const next = [...reparsed(previous), userMessage("third", 3)];
		const adopted = identity.module.adoptSnapshotIdentities({
			previous,
			next,
			windowSize: 10,
			identityOf: store.get,
			adopt: store.adopt,
		});

		assert.equal(adopted, 2);
		assert.equal(store.get(next[2]), undefined);
	} finally {
		await identity.dispose();
	}
});

test("pairing follows content, not position", async () => {
	const identity = await loadIdentity();
	try {
		const store = identityStore();
		const previous = [userMessage("first", 1), userMessage("second", 2)];
		previous.forEach(store.ensure);
		const secondKey = store.get(previous[1]).key;

		// A snapshot that dropped the head: the surviving message must keep its own
		// slot rather than inherit the slot of whatever now sits at index 0.
		const next = reparsed([previous[1]]);
		const adopted = identity.module.adoptSnapshotIdentities({
			previous,
			next,
			windowSize: 10,
			identityOf: store.get,
			adopt: store.adopt,
		});

		assert.equal(adopted, 1);
		assert.equal(store.get(next[0]).key, secondKey);
	} finally {
		await identity.dispose();
	}
});

test("only the tail window is considered", async () => {
	const identity = await loadIdentity();
	try {
		const store = identityStore();
		const previous = [
			userMessage("first", 1),
			userMessage("second", 2),
			userMessage("third", 3),
		];
		previous.forEach(store.ensure);

		const next = reparsed(previous);
		const adopted = identity.module.adoptSnapshotIdentities({
			previous,
			next,
			windowSize: 2,
			identityOf: store.get,
			adopt: store.adopt,
		});

		assert.equal(adopted, 2);
		assert.equal(store.get(next[0]), undefined);
		assert.notEqual(store.get(next[1]), undefined);
	} finally {
		await identity.dispose();
	}
});

test("an empty or unusable previous snapshot adopts nothing", async () => {
	const identity = await loadIdentity();
	try {
		const store = identityStore();
		const next = [userMessage("first", 1)];
		assert.equal(
			identity.module.adoptSnapshotIdentities({
				previous: [],
				next,
				windowSize: 10,
				identityOf: store.get,
				adopt: store.adopt,
			}),
			0,
		);
		assert.equal(store.get(next[0]), undefined);

		// Messages the previous snapshot never keyed (nothing had rendered them yet)
		// have no identity to pass on.
		const unkeyed = [userMessage("first", 1)];
		assert.equal(
			identity.module.adoptSnapshotIdentities({
				previous: unkeyed,
				next: reparsed(unkeyed),
				windowSize: 10,
				identityOf: store.get,
				adopt: store.adopt,
			}),
			0,
		);
	} finally {
		await identity.dispose();
	}
});

/**
 * `applySnapshot` cannot be loaded here (it is reachable only through
 * `main.ts`, which runs `acquireVsCodeApi()` and touches the document at import
 * time), so this asserts the one property the unit tests cannot: ordering. The
 * adoption reads the outgoing array, so it is correct only before the swap —
 * after it, it would compare the incoming messages with themselves and adopt
 * nothing, silently reverting the whole fix. Odd as a source assertion is, it is
 * the same tradeoff `transcript-sections.test.mjs` documents for its own
 * `main.ts` check.
 */
test("applySnapshot adopts identities before it swaps the array", async () => {
	const source = await readFile("webview/main.ts", "utf8");
	const body = /function applySnapshot\(([\s\S]*?)\n\}/u.exec(source)?.[1];
	assert.ok(body, "applySnapshot must exist in main.ts");
	const adoptedAt = body.indexOf(
		"adoptSnapshotMessageIdentities(message.messages)",
	);
	const swappedAt = body.indexOf("ui.messages = message.messages");
	assert.notEqual(adoptedAt, -1, "applySnapshot must adopt snapshot identities");
	assert.notEqual(
		swappedAt,
		-1,
		"applySnapshot must still install the messages",
	);
	assert.ok(
		adoptedAt < swappedAt,
		"identity must be adopted from the outgoing messages, so before the swap",
	);
});

/**
 * The end-to-end payoff, through the three real modules: a snapshot re-parses
 * every message, adoption puts the identities back, and the incremental view
 * therefore finds every signature unchanged and keeps every node.
 *
 * The fail case this guards is precisely the reported bug — with adoption
 * removed, no message has an identity, every entry collapses onto the same key,
 * and the counter below goes from `reused` to `created`.
 */
test("a snapshot whose content is unchanged rebuilds no nodes", async () => {
	const identity = await loadIdentity();
	const renderer = await loadRenderer();
	const view = await loadTranscriptView();
	try {
		const store = identityStore();
		const toolResult = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: 4,
		};
		const first = [
			userMessage("what does this do?", 1),
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "considering" },
					{ type: "text", text: "It reads the file." },
					{ type: "toolCall", id: "t1", name: "read", arguments: {} },
				],
				stopReason: "toolUse",
				timestamp: 2,
			},
			toolResult,
			userMessage("thanks", 5),
		];
		// Only what has rendered carries an identity; the rest is not on screen.
		first.forEach(store.ensure);
		// toolResult has no node of its own, but its identity is part of the assistant
		// signature, so it has to be adopted too.
		const results = new Map([["t1", toolResult]]);

		const entries = (messages, messageResults) =>
			messages.map((message) => ({
				key: String(store.get(message)?.key),
				signature: renderer.module.messageRenderSignature(
					message,
					messageResults,
					new Map(),
					false,
					store.describe,
				),
			}));

		const children = [];
		const transcript = new view.module.TranscriptView({
			container: {
				insertBefore(node, reference) {
					const existing = children.indexOf(node);
					if (existing >= 0) children.splice(existing, 1);
					const at =
						reference === null ? children.length : children.indexOf(reference);
					children.splice(at < 0 ? children.length : at, 0, node);
				},
				removeChild(node) {
					const at = children.indexOf(node);
					if (at >= 0) children.splice(at, 1);
				},
			},
			createNode: (entry) => ({ id: `${entry.key}@${entry.signature}` }),
		});

		const initial = transcript.update(entries(first, results));
		assert.equal(initial.created, first.length);
		const nodeIds = children.map((node) => node.id);

		const second = reparsed(first);
		const secondResults = new Map([["t1", second[2]]]);
		identity.module.adoptSnapshotIdentities({
			previous: first,
			next: second,
			windowSize: 150,
			identityOf: store.get,
			adopt: store.adopt,
		});
		const settled = transcript.update(entries(second, secondResults));

		assert.equal(settled.created, 0);
		assert.equal(settled.reused, second.length);
		assert.deepEqual(
			children.map((node) => node.id),
			nodeIds,
		);
	} finally {
		await identity.dispose();
		await renderer.dispose();
		await view.dispose();
	}
});
