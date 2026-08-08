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

test("command validation keeps usable rows and drops unusable ones", async () => {
	const loaded = await loadValidation();
	try {
		const commands = loaded.module.parseCommandsResponse({
			commands: [
				{
					name: "session-name",
					description: "Set or clear session name",
					source: "extension",
					path: "/home/user/.pi/agent/extensions/session.ts",
				},
				{ name: "fix-tests", source: "prompt", location: "project" },
				{ name: "skill:brave-search", source: "skill", location: "user" },
			],
		});
		assert.deepEqual(
			commands.map((command) => command.name),
			["session-name", "fix-tests", "skill:brave-search"],
		);
		assert.equal(commands[0].description, "Set or clear session name");
		assert.equal(commands[1].location, "project");
		assert.equal(commands[1].description, undefined);

		// A source pi adds later must survive: the panel should lose the grouping
		// header, not the row.
		assert.equal(
			loaded.module.parseCommandsResponse({
				commands: [{ name: "future", source: "workflow" }],
			})[0].source,
			"workflow",
		);

		// One malformed entry must not blank the whole list.
		assert.deepEqual(
			loaded.module
				.parseCommandsResponse({
					commands: [
						{ description: "no name at all" },
						{ name: "" },
						{ name: 42 },
						{ name: "x".repeat(513) },
						{ name: "keeper" },
					],
				})
				.map((command) => command.name),
			["keeper"],
		);
	} finally {
		await loaded.dispose();
	}
});

test("command validation rejects malformed envelopes and oversized fields", async () => {
	const loaded = await loadValidation();
	try {
		assert.throws(
			() => loaded.module.parseCommandsResponse(null),
			/must be an object/iu,
		);
		assert.throws(
			() => loaded.module.parseCommandsResponse({ commands: "nope" }),
			/must be an array/iu,
		);
		assert.throws(
			() =>
				loaded.module.parseCommandsResponse({
					commands: Array.from({ length: 2_001 }, (_value, index) => ({
						name: `command-${index}`,
					})),
				}),
			/exceeds the 2000-item limit/iu,
		);
		assert.throws(
			() =>
				loaded.module.parseCommandsResponse({
					commands: [{ name: "big", description: "x".repeat(8 * 1024 + 1) }],
				}),
			/is too large/iu,
		);
		assert.throws(
			() =>
				loaded.module.parseCommandsResponse({
					commands: [{ name: "bad-source", source: 7 }],
				}),
			/must be a string/iu,
		);
	} finally {
		await loaded.dispose();
	}
});
