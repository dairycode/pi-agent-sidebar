import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadCapabilities() {
	return loadBundledModule({
		entry: "src/rpc/piCapabilities.ts",
		name: "pi-capabilities",
	});
}

test("only an unknown-command error counts as an unsupported capability", async () => {
	const loaded = await loadCapabilities();
	try {
		const { isUnsupportedCommandError } = loaded.module;
		// The exact wording a live pi 0.84.3 returns for a command it does not have.
		assert.equal(
			isUnsupportedCommandError(new Error("Unknown command: clone")),
			true,
		);
		assert.equal(isUnsupportedCommandError("Unsupported command: fork"), true);
		assert.equal(
			isUnsupportedCommandError(new Error("Unrecognized command 'get_tree'")),
			true,
		);

		// A supported command failing on its arguments or state must stay a plain
		// failure, otherwise one bad entry id would permanently hide forking.
		assert.equal(
			isUnsupportedCommandError(new Error("Invalid entry ID for forking")),
			false,
		);
		assert.equal(
			isUnsupportedCommandError(
				new Error("Pi RPC command 'clone' timed out after 30000ms."),
			),
			false,
		);
		assert.equal(isUnsupportedCommandError(undefined), false);
		assert.equal(isUnsupportedCommandError(""), false);
		// An absurdly long message is not parsed as a capability signal.
		assert.equal(
			isUnsupportedCommandError(`Unknown command: ${"x".repeat(20_000)}`),
			false,
		);
	} finally {
		await loaded.dispose();
	}
});

test("capability tracker starts optimistic and only downgrades on real evidence", async () => {
	const loaded = await loadCapabilities();
	try {
		const tracker = new loaded.module.PiCapabilityTracker();
		assert.deepEqual(tracker.snapshot(), {
			clone: true,
			fork: true,
			forkMessages: true,
			entries: true,
			tree: true,
		});

		// An argument error leaves the capability enabled.
		assert.equal(
			tracker.recordFailure("fork", new Error("Invalid entry ID for forking")),
			false,
		);
		assert.equal(tracker.isAvailable("fork"), true);

		// An unknown-command error disables just that capability.
		assert.equal(
			tracker.recordFailure("clone", new Error("Unknown command: clone")),
			true,
		);
		assert.equal(tracker.isAvailable("clone"), false);
		assert.equal(tracker.isAvailable("fork"), true);

		// Restarting onto a different binary must not inherit the old verdict.
		tracker.reset();
		assert.equal(tracker.isAvailable("clone"), true);

		tracker.recordFailure("tree", new Error("Unknown command: get_tree"));
		assert.equal(tracker.isAvailable("tree"), false);
		tracker.recordSuccess("tree");
		assert.equal(tracker.isAvailable("tree"), true);

		// The snapshot is a copy: mutating it must not reach the tracker.
		const snapshot = tracker.snapshot();
		snapshot.clone = false;
		assert.equal(tracker.isAvailable("clone"), true);
	} finally {
		await loaded.dispose();
	}
});
