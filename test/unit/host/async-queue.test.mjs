import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

test("AsyncQueue serializes mutations and continues after rejection", async () => {
	const loaded = await loadBundledModule({
		entry: "src/provider/asyncQueue.ts",
		name: "async-queue",
	});
	try {
		const { AsyncQueue } = loaded.module;
		const queue = new AsyncQueue();
		const order = [];
		let releaseFirst;
		const firstGate = new Promise((resolve) => {
			releaseFirst = resolve;
		});
		const first = queue.enqueue(async () => {
			order.push("first:start");
			await firstGate;
			order.push("first:end");
		});
		const second = queue.enqueue(async () => {
			order.push("second");
			throw new Error("expected failure");
		});
		const third = queue.enqueue(async () => {
			order.push("third");
		});
		await Promise.resolve();
		assert.deepEqual(order, ["first:start"]);
		releaseFirst();
		await first;
		await assert.rejects(second, /expected failure/iu);
		await third;
		await queue.drain();
		assert.deepEqual(order, ["first:start", "first:end", "second", "third"]);
	} finally {
		await loaded.dispose();
	}
});
