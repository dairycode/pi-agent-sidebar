import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	loadBundledModule,
	projectRoot,
} from "../../helpers/load-bundled-module.mjs";

const root = projectRoot;

test("session history reads and safely deletes custom-directory sessions", async () => {
	const loaded = await loadBundledModule({
		entry: "src/services/sessionStore.ts",
		name: "session-store",
	});
	const sessionsDirectory = path.join(
		loaded.temporaryDirectory,
		"custom-sessions",
	);
	await mkdir(sessionsDirectory, { recursive: true });
	await writeFile(
		path.join(sessionsDirectory, "session.jsonl"),
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-id",
				timestamp: "2026-01-02T03:04:05.000Z",
				cwd: root,
			}),
			JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-02T03:04:06.000Z",
				message: { role: "user", content: "Implement the sidebar" },
			}),
			JSON.stringify({
				type: "session_info",
				id: "entry-2",
				parentId: "entry-1",
				timestamp: "2026-01-02T03:04:07.000Z",
				name: "Sidebar work",
			}),
		].join("\n"),
		"utf8",
	);

	try {
		const {
			deleteProjectSession,
			listProjectSessions,
			resolveSessionDirectory,
		} = loaded.module;
		assert.equal(
			resolveSessionDirectory(root, "relative-sessions", undefined),
			path.resolve(root, "relative-sessions"),
		);
		assert.equal(
			resolveSessionDirectory(root, "", "environment-sessions"),
			path.resolve(root, "environment-sessions"),
		);
		const sessions = await listProjectSessions(
			root,
			undefined,
			sessionsDirectory,
		);
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].title, "Sidebar work");
		assert.equal(sessions[0].excerpt, "Implement the sidebar");

		await assert.rejects(
			deleteProjectSession(
				root,
				sessions[0].path,
				sessions[0].path,
				sessionsDirectory,
			),
			/The active session cannot be deleted/u,
		);
		await assert.rejects(
			deleteProjectSession(
				root,
				path.join(loaded.temporaryDirectory, "outside.jsonl"),
				undefined,
				sessionsDirectory,
			),
			/Session is not part of this workspace/u,
		);

		await deleteProjectSession(
			root,
			sessions[0].path,
			undefined,
			sessionsDirectory,
		);
		assert.deepEqual(
			await listProjectSessions(root, undefined, sessionsDirectory),
			[],
		);
	} finally {
		await loaded.dispose();
	}
});
