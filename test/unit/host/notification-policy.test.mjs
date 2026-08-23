import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadPolicy() {
	return loadBundledModule({
		entry: "src/provider/notificationPolicy.ts",
		name: "notification-policy",
	});
}

test("passive pi notifications are routed to the output log", async () => {
	const loaded = await loadPolicy();
	try {
		assert.equal(loaded.module.notificationDestination("info"), "log");
		assert.equal(loaded.module.notificationDestination(undefined), "log");
		assert.equal(loaded.module.notificationDestination("success"), "log");
	} finally {
		await loaded.dispose();
	}
});

test("warning and error pi notifications remain visible", async () => {
	const loaded = await loadPolicy();
	try {
		assert.equal(loaded.module.notificationDestination("warning"), "warning");
		assert.equal(loaded.module.notificationDestination("error"), "error");
	} finally {
		await loaded.dispose();
	}
});
