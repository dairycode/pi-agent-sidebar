import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadPiRpcClient() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-rpc-test-"),
	);
	const output = path.join(temporaryDirectory, "pi-rpc-client.mjs");
	await build({
		entryPoints: [path.join(root, "src", "piRpcClient.ts")],
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

function fakeClient(PiRpcClient) {
	return new PiRpcClient({
		binary: process.execPath,
		args: [path.join(root, "scripts", "fixtures", "fake-rpc.mjs")],
		cwd: root,
		env: process.env,
	});
}

test("PiRpcClient tolerates scalar JSON and strict fragmented UTF-8 records", async () => {
	const loaded = await loadPiRpcClient();
	try {
		const client = fakeClient(loaded.module.PiRpcClient);
		const protocolErrors = [];
		client.onProtocolError((message) => protocolErrors.push(message));

		await client.start();
		const state = await client.request({ type: "get_state" });
		assert.equal(state.sessionName, "snow 雪\u2028pi");
		assert.equal(state.isStreaming, false);
		assert.deepEqual(protocolErrors, ["Ignored a non-object Pi RPC record."]);
		const started = Date.now();
		await client.stop();
		assert.equal(client.isRunning, false);
		assert.ok(
			Date.now() - started < 500,
			"normal stop waited for escalation timers",
		);
	} finally {
		await loaded.dispose();
	}
});

test("PiRpcClient rejects timed-out and process-aborted requests", async () => {
	const loaded = await loadPiRpcClient();
	try {
		const timeoutClient = fakeClient(loaded.module.PiRpcClient);
		await timeoutClient.start();
		await assert.rejects(
			timeoutClient.request({ type: "hang" }, 30),
			/timed out after 30ms/iu,
		);
		await timeoutClient.stop();

		const exitClient = fakeClient(loaded.module.PiRpcClient);
		await exitClient.start();
		await assert.rejects(
			exitClient.request({ type: "exit_now" }, 2_000),
			/process exited .* before 'exit_now' completed/iu,
		);
		assert.equal(exitClient.isRunning, false);
	} finally {
		await loaded.dispose();
	}
});

test("PiRpcClient reports spawn failures", async () => {
	const loaded = await loadPiRpcClient();
	try {
		const client = new loaded.module.PiRpcClient({
			binary: path.join(os.tmpdir(), `missing-pi-${Date.now()}`),
			args: [],
			cwd: root,
			env: process.env,
		});
		await assert.rejects(client.start());
		assert.equal(client.isRunning, false);
	} finally {
		await loaded.dispose();
	}
});
