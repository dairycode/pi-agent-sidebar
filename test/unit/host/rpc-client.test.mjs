import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

const root = process.cwd();

async function loadPiRpcClient() {
	return loadBundledModule({
		entry: "src/rpc/piRpcClient.ts",
		name: "pi-rpc-client",
	});
}

function fakeClient(PiRpcClient) {
	return new PiRpcClient({
		binary: process.execPath,
		args: [path.join(root, "test", "fixtures", "fake-rpc.mjs")],
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

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDeath(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !isAlive(pid);
}

/**
 * Stopping the client has to stop what pi started, not just pi.
 *
 * pi runs the bash tool by spawning a shell. Signalling only the direct child —
 * all `child.kill()` can reach — leaves those running after the view is closed: a
 * `sleep`, or a dev server holding the port it was started on. The child is
 * spawned into its own process group so the group can be signalled as a whole;
 * without that, a group kill would reach the extension host itself.
 *
 * Windows has no process group to signal (`taskkill /T` is a separate process),
 * so these cases are POSIX-only, like the fix.
 */
const groupSignal = {
	skip: process.platform === "win32" ? "POSIX only" : false,
};

function cleanupHelper(pid) {
	if (!pid || !isAlive(pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Gone between the check and the signal.
	}
}

test(
	"stop() also stops tools pi left running behind it",
	groupSignal,
	async () => {
		const loaded = await loadPiRpcClient();
		let helper;
		try {
			const client = fakeClient(loaded.module.PiRpcClient);
			await client.start();
			helper = (await client.request({ type: "spawn_helper" })).pid;
			assert.ok(isAlive(helper), "the helper should be running before stop()");

			await client.stop();

			assert.ok(
				await waitForDeath(helper, 2_000),
				`helper ${helper} outlived stop() — pi's children are orphaned`,
			);
		} finally {
			cleanupHelper(helper);
			await loaded.dispose();
		}
	},
);

test(
	"stop() stops those tools even when pi holds its pipes open",
	groupSignal,
	async () => {
		const loaded = await loadPiRpcClient();
		let helper;
		try {
			const client = fakeClient(loaded.module.PiRpcClient);
			await client.start();
			helper = (await client.request({ type: "spawn_helper", keepRunning: true }))
				.pid;
			assert.ok(isAlive(helper), "the helper should be running before stop()");

			// pi ignores the stdin EOF here, so the escalation timers have to fire and
			// reach the group.
			await client.stop();

			assert.equal(client.isRunning, false);
			assert.ok(
				await waitForDeath(helper, 2_000),
				`helper ${helper} survived the escalation timers`,
			);
		} finally {
			cleanupHelper(helper);
			await loaded.dispose();
		}
	},
);

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
