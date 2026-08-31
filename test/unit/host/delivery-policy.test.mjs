import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadPolicy() {
	return loadBundledModule({
		entry: "src/provider/deliveryPolicy.ts",
		name: "delivery-policy",
	});
}

test("an explicit delivery choice is forwarded to pi unchanged", async () => {
	const loaded = await loadPolicy();
	try {
		const { streamingBehaviorFor } = loaded.module;
		for (const isStreaming of [true, false]) {
			assert.equal(streamingBehaviorFor("steer", isStreaming), "steer");
			assert.equal(streamingBehaviorFor("followUp", isStreaming), "followUp");
		}
	} finally {
		await loaded.dispose();
	}
});

test("an omitted choice steers only while pi is known to be streaming", async () => {
	const loaded = await loadPolicy();
	try {
		const { streamingBehaviorFor } = loaded.module;
		// pi rejects a prompt sent mid-run without streamingBehavior, so the
		// streaming case must not fall through as a plain prompt.
		assert.equal(streamingBehaviorFor(undefined, true), "steer");
		assert.equal(streamingBehaviorFor(undefined, false), undefined);
	} finally {
		await loaded.dispose();
	}
});
