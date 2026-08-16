import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

test("AsyncQueue serializes mutations and continues after rejection", async () => {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-async-queue-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "async-queue.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "src", "provider", "asyncQueue.ts")],
		outfile: output,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
	});
	try {
		const { AsyncQueue } = await import(
			`${pathToFileURL(output).href}?v=${Date.now()}`
		);
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
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
});
