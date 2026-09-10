import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadMediaSources() {
	return loadBundledModule({
		entry: "webview/transcript/mediaSources.ts",
		name: "media-sources",
		platform: "browser",
	});
}

function harness(MediaSources) {
	const batches = [];
	const sources = new MediaSources((requestId, requested) => {
		batches.push({ requestId, sources: requested });
	});
	return { sources, batches };
}

test("a source is answered once and then served from the cache", async () => {
	const loaded = await loadMediaSources();
	try {
		const { sources, batches } = harness(loaded.module.MediaSources);
		assert.equal(sources.uriFor("/tmp/a.png"), undefined);

		sources.request(["/tmp/a.png", "/tmp/a.png"]);
		assert.equal(batches.length, 1);
		assert.deepEqual(batches[0].sources, ["/tmp/a.png"]);
		// A second render of the same message must not ask again.
		sources.request(["/tmp/a.png"]);
		assert.equal(batches.length, 1);

		assert.deepEqual(
			sources.applyResolved(batches[0].requestId, [
				{ source: "/tmp/a.png", uri: "vscode-webview://a.png" },
			]),
			["/tmp/a.png"],
		);
		assert.equal(sources.uriFor("/tmp/a.png"), "vscode-webview://a.png");
		assert.equal(sources.isRefused("/tmp/a.png"), false);

		sources.request(["/tmp/a.png"]);
		assert.equal(batches.length, 1);
	} finally {
		await loaded.dispose();
	}
});

test("a source the host leaves out is refused and never retried", async () => {
	const loaded = await loadMediaSources();
	try {
		const { sources, batches } = harness(loaded.module.MediaSources);

		sources.request(["/etc/passwd.png"]);
		assert.deepEqual(sources.applyResolved(batches[0].requestId, []), [
			"/etc/passwd.png",
		]);
		assert.equal(sources.isRefused("/etc/passwd.png"), true);
		assert.equal(sources.uriFor("/etc/passwd.png"), undefined);

		// The same path appears in every re-render of the message it came from.
		sources.request(["/etc/passwd.png"]);
		sources.request(["/etc/passwd.png", "/tmp/b.png"]);
		assert.equal(batches.length, 2);
		assert.deepEqual(batches[1].sources, ["/tmp/b.png"]);
	} finally {
		await loaded.dispose();
	}
});

test("batches are chunked at the protocol ceiling", async () => {
	const loaded = await loadMediaSources();
	try {
		const { sources, batches } = harness(loaded.module.MediaSources);
		const many = Array.from({ length: 21 }, (_, index) => `/tmp/${index}.png`);

		sources.request(many);

		assert.equal(batches.length, 2);
		assert.equal(batches[0].sources.length, 20);
		assert.deepEqual(batches[1].sources, ["/tmp/20.png"]);
	} finally {
		await loaded.dispose();
	}
});

test("a source too long for the parser is refused without asking", async () => {
	const loaded = await loadMediaSources();
	try {
		const { sources, batches } = harness(loaded.module.MediaSources);
		// The parser's per-entry ceiling, which the webview has to apply before it
		// sends: one entry over it makes the parser drop the whole message.
		const oversized = `/${"a".repeat(32 * 1024)}.png`;
		const atLimit = `/${"b".repeat(32 * 1024 - 5)}.png`;

		assert.deepEqual(sources.request([oversized, atLimit, "/tmp/ok.png"]), [
			oversized,
		]);
		assert.equal(sources.isRefused(oversized), true);
		// The oversized source is left out instead of taking its batch mates with it.
		assert.equal(batches.length, 1);
		assert.deepEqual(batches[0].sources, [atLimit, "/tmp/ok.png"]);
	} finally {
		await loaded.dispose();
	}
});

test("clearing refusals re-asks, and keeps the answers", async () => {
	const loaded = await loadMediaSources();
	try {
		const { sources, batches } = harness(loaded.module.MediaSources);

		sources.request(["/tmp/a.png", "/etc/passwd.png"]);
		sources.applyResolved(batches[0].requestId, [
			{ source: "/tmp/a.png", uri: "vscode-webview://a.png" },
		]);
		assert.equal(sources.isRefused("/etc/passwd.png"), true);

		// A path refused in one session may name a file that exists in the next: it is
		// asked about again, while the URI already handed out stays good.
		sources.clearRefusals();
		assert.equal(sources.isRefused("/etc/passwd.png"), false);
		sources.request(["/tmp/a.png", "/etc/passwd.png"]);
		assert.equal(batches.length, 2);
		assert.deepEqual(batches[1].sources, ["/etc/passwd.png"]);
		assert.equal(sources.uriFor("/tmp/a.png"), "vscode-webview://a.png");
	} finally {
		await loaded.dispose();
	}
});

test("a reply to an unknown batch is ignored", async () => {
	const loaded = await loadMediaSources();
	try {
		const { sources } = harness(loaded.module.MediaSources);

		// A reloaded webview can receive a reply to a request it never sent; it is
		// not evidence about any source.
		assert.deepEqual(
			sources.applyResolved(99, [{ source: "/tmp/a.png", uri: "x" }]),
			[],
		);
		assert.equal(sources.uriFor("/tmp/a.png"), undefined);
		assert.equal(sources.isRefused("/tmp/a.png"), false);
	} finally {
		await loaded.dispose();
	}
});

test("a source answered twice in one reply is cached and reported once", async () => {
	const loaded = await loadMediaSources();
	try {
		const { sources, batches } = harness(loaded.module.MediaSources);

		sources.request(["/tmp/a.png"]);
		// The duplicated entry is one change; the stranger was never asked about, so
		// the reply is not evidence about it either way.
		assert.deepEqual(
			sources.applyResolved(batches[0].requestId, [
				{ source: "/tmp/a.png", uri: "vscode-webview://a.png" },
				{ source: "/tmp/a.png", uri: "vscode-webview://a.png" },
				{ source: "/tmp/other.png", uri: "vscode-webview://other.png" },
			]),
			["/tmp/a.png"],
		);
		assert.equal(sources.uriFor("/tmp/a.png"), "vscode-webview://a.png");
		assert.equal(sources.uriFor("/tmp/other.png"), undefined);
	} finally {
		await loaded.dispose();
	}
});
