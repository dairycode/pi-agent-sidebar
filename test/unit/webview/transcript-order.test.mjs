import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadTranscriptOrder() {
	return loadBundledModule({
		entry: "webview/transcript/transcriptOrder.ts",
		name: "transcript-order",
	});
}

const user = (id) => ({
	id,
	role: "user",
	content: [{ type: "text", text: id }],
});
const assistant = (id) => ({
	id,
	role: "assistant",
	content: [{ type: "text", text: id }],
});

test("no reply in flight leaves the list untouched", async () => {
	const loaded = await loadTranscriptOrder();
	try {
		const messages = [user("u1"), assistant("a1")];
		assert.equal(loaded.module.withLiveReply(messages, undefined, 2), messages);
	} finally {
		await loaded.dispose();
	}
});

test("a reply that started last stays last", async () => {
	const loaded = await loadTranscriptOrder();
	try {
		const messages = [user("u1")];
		const live = assistant("a1");
		assert.deepEqual(loaded.module.withLiveReply(messages, live, 1), [
			messages[0],
			live,
		]);
	} finally {
		await loaded.dispose();
	}
});

test("a follow-up delivered mid-reveal stays after the reply it followed", async () => {
	const loaded = await loadTranscriptOrder();
	try {
		const earlier = user("u1");
		const live = assistant("a1");
		// pi accepted the follow-up while the reply above was still revealing, so
		// it is already in the list the reply is not.
		const messages = [earlier, user("u2")];
		assert.deepEqual(loaded.module.withLiveReply(messages, live, 1), [
			earlier,
			live,
			messages[1],
		]);
	} finally {
		await loaded.dispose();
	}
});

test("a reply a snapshot already listed keeps pi's position", async () => {
	const loaded = await loadTranscriptOrder();
	try {
		const live = assistant("a1");
		const messages = [user("u1"), live, user("u2")];
		assert.equal(loaded.module.withLiveReply(messages, live, 1), messages);
	} finally {
		await loaded.dispose();
	}
});

test("a reply listed anywhere keeps pi's order instead of being duplicated", async () => {
	const loaded = await loadTranscriptOrder();
	try {
		const live = assistant("a1");
		const messages = [user("u1"), live];
		// The recorded index can trail the snapshot that placed the reply: the list
		// pi sent is authoritative at any position, not just at the index.
		assert.equal(loaded.module.withLiveReply(messages, live, 0), messages);
		assert.equal(loaded.module.withLiveReply(messages, live, 9), messages);
	} finally {
		await loaded.dispose();
	}
});

test("an index past the end appends instead of throwing", async () => {
	const loaded = await loadTranscriptOrder();
	try {
		const messages = [user("u1")];
		const live = assistant("a1");
		// A snapshot can replace the list with a shorter window mid-reply.
		assert.deepEqual(loaded.module.withLiveReply(messages, live, 9), [
			messages[0],
			live,
		]);
	} finally {
		await loaded.dispose();
	}
});

test("a settled reply is inserted ahead of messages that arrived during its reveal", async () => {
	const loaded = await loadTranscriptOrder();
	try {
		const first = user("u1");
		const followUp = user("u2");
		const messages = [first, followUp];
		const reply = assistant("a1");
		loaded.module.insertReply(messages, reply, 1);
		assert.deepEqual(messages, [first, reply, followUp]);
	} finally {
		await loaded.dispose();
	}
});

test("a settled reply pi already listed is not inserted twice", async () => {
	const loaded = await loadTranscriptOrder();
	try {
		const first = user("u1");
		const reply = assistant("a1");
		const followUp = user("u2");
		const messages = [first, reply, followUp];
		loaded.module.insertReply(messages, reply, 1);
		assert.deepEqual(messages, [first, reply, followUp]);
	} finally {
		await loaded.dispose();
	}
});
