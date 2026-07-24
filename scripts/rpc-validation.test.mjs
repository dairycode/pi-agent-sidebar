import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadValidation() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-rpc-validation-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "validation.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "src", "rpcValidation.ts")],
		outfile: output,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
	});
	return {
		module: await import(`${pathToFileURL(output).href}?v=${Date.now()}`),
		dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
	};
}

test("Pi snapshot validation accepts supported records", async () => {
	const loaded = await loadValidation();
	try {
		assert.equal(
			loaded.module.parsePiState({ sessionId: "session", isStreaming: false })
				.sessionId,
			"session",
		);
		assert.deepEqual(
			loaded.module.parseMessagesResponse({
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
					},
				],
			}),
			[
				{
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
				},
			],
		);
	} finally {
		await loaded.dispose();
	}
});

test("Pi snapshot validation rejects malformed shapes and oversized content", async () => {
	const loaded = await loadValidation();
	try {
		assert.throws(
			() => loaded.module.parsePiState(null),
			/must be an object/iu,
		);
		assert.throws(
			() => loaded.module.parseMessagesResponse({ messages: "not-an-array" }),
			/must be an array/iu,
		);
		assert.throws(
			() =>
				loaded.module.parseMessagesResponse({
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "x".repeat(1_000_001) }],
						},
					],
				}),
			/is too large/iu,
		);
		assert.throws(
			() =>
				loaded.module.validateRpcEvent({ type: "message_update", message: 3 }),
			/must be an object/iu,
		);
	} finally {
		await loaded.dispose();
	}
});
