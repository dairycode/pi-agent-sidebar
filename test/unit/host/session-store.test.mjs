import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
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
		const { deleteProjectSession, listProjectSessions, resolveSessionDirectory } =
			loaded.module;
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
		// The header timestamp is the creation time, never "last activity".
		assert.equal(sessions[0].createdAt, "2026-01-02T03:04:05.000Z");
		assert.equal(sessions[0].lastActivityAt, "2026-01-02T03:04:06.000Z");

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

test("session activity uses message timestamps and tolerates malformed entries", async () => {
	const loaded = await loadBundledModule({
		entry: "src/services/sessionStore.ts",
		name: "session-store-activity",
	});
	const sessionsDirectory = path.join(loaded.temporaryDirectory, "sessions");
	await mkdir(sessionsDirectory, { recursive: true });

	// An epoch-millisecond message timestamp wins over the entry's ISO time, the
	// same rule pi's own session metadata uses.
	await writeFile(
		path.join(sessionsDirectory, "activity.jsonl"),
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "activity",
				timestamp: "2026-01-02T00:00:00.000Z",
				cwd: root,
			}),
			"{ this line is not json",
			JSON.stringify({
				type: "message",
				id: "user-one",
				parentId: null,
				timestamp: "2026-01-02T01:00:00.000Z",
				message: {
					role: "user",
					content: "First prompt",
					timestamp: Date.parse("2026-01-02T02:00:00.000Z"),
				},
			}),
			JSON.stringify({
				type: "message",
				id: "assistant-one",
				parentId: "user-one",
				timestamp: "2026-01-02T03:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					timestamp: Date.parse("2026-01-02T04:00:00.000Z"),
					stopReason: "stop",
				},
			}),
			// A tool result is a message entry but not conversational activity.
			JSON.stringify({
				type: "message",
				id: "tool-one",
				parentId: "assistant-one",
				timestamp: "2026-01-02T09:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "output" }],
					isError: false,
				},
			}),
		].join("\n"),
		"utf8",
	);

	// A header-only session has no activity entries at all.
	await writeFile(
		path.join(sessionsDirectory, "empty.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "empty",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: root,
		})}\n`,
		"utf8",
	);

	// A session belonging to another workspace must never be listed.
	await writeFile(
		path.join(sessionsDirectory, "foreign.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "foreign",
			timestamp: "2026-06-01T00:00:00.000Z",
			cwd: path.join(root, "..", "other-project"),
		})}\n`,
		"utf8",
	);

	// A file whose first line is not a session header is not a pi session.
	await writeFile(
		path.join(sessionsDirectory, "headerless.jsonl"),
		'{"type":"message","id":"x","parentId":null}\n',
		"utf8",
	);

	try {
		const sessions = await loaded.module.listProjectSessions(
			root,
			undefined,
			sessionsDirectory,
		);
		assert.deepEqual(
			sessions.map((session) => path.basename(session.path)),
			["activity.jsonl", "empty.jsonl"],
		);

		const [activity, empty] = sessions;
		assert.equal(activity.createdAt, "2026-01-02T00:00:00.000Z");
		assert.equal(activity.lastActivityAt, "2026-01-02T04:00:00.000Z");
		assert.equal(activity.excerpt, "First prompt");

		// With no activity entries, last activity falls back to creation time
		// rather than pretending the file mtime was a conversation.
		assert.equal(empty.createdAt, "2026-01-01T00:00:00.000Z");
		assert.equal(empty.lastActivityAt, "2026-01-01T00:00:00.000Z");
		assert.equal(empty.title, "Untitled");
	} finally {
		await loaded.dispose();
	}
});

test("oversized sessions read bounded head and tail without inventing entries", async () => {
	const loaded = await loadBundledModule({
		entry: "src/services/sessionStore.ts",
		name: "session-store-bounded",
	});
	const sessionsDirectory = path.join(loaded.temporaryDirectory, "sessions");
	await mkdir(sessionsDirectory, { recursive: true });

	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: "huge",
		timestamp: "2026-01-02T00:00:00.000Z",
		cwd: root,
	});
	const firstUser = JSON.stringify({
		type: "message",
		id: "user-one",
		parentId: null,
		timestamp: "2026-01-02T01:00:00.000Z",
		message: {
			role: "user",
			content: "Head prompt",
			timestamp: Date.parse("2026-01-02T01:00:00.000Z"),
		},
	});
	// Padding pushes the file past the 2 MiB full-read ceiling so the head/tail
	// path runs. Each padding entry is a valid line so a truncated line can only
	// come from the byte-window boundary itself.
	const padding = Array.from({ length: 4_000 }, (_value, index) =>
		JSON.stringify({
			type: "custom",
			id: `pad-${index}`,
			parentId: "user-one",
			timestamp: "2026-01-02T02:00:00.000Z",
			customType: "padding",
			data: { filler: "x".repeat(700) },
		}),
	);
	const lastAssistant = JSON.stringify({
		type: "message",
		id: "assistant-last",
		parentId: "user-one",
		timestamp: "2026-01-02T08:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Tail answer" }],
			timestamp: Date.parse("2026-01-02T09:00:00.000Z"),
			stopReason: "stop",
		},
	});
	const sessionPath = path.join(sessionsDirectory, "huge.jsonl");
	await writeFile(
		sessionPath,
		`${[header, firstUser, ...padding, lastAssistant].join("\n")}\n`,
		"utf8",
	);

	try {
		const { size } = await stat(sessionPath);
		assert.ok(size > 2 * 1024 * 1024, "fixture must exceed the full-read limit");

		const [session] = await loaded.module.listProjectSessions(
			root,
			undefined,
			sessionsDirectory,
		);
		assert.equal(session.createdAt, "2026-01-02T00:00:00.000Z");
		// The head window still carries the first prompt, and the tail window the
		// newest assistant reply.
		assert.equal(session.excerpt, "Head prompt");
		assert.equal(session.lastActivityAt, "2026-01-02T09:00:00.000Z");
	} finally {
		await loaded.dispose();
	}
});

test("session history sorts by newest activity, not header order", async () => {
	const loaded = await loadBundledModule({
		entry: "src/services/sessionStore.ts",
		name: "session-store-sort",
	});
	const sessionsDirectory = path.join(loaded.temporaryDirectory, "sessions");
	await mkdir(sessionsDirectory, { recursive: true });

	const write = async (name, createdAt, activityAt) => {
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: name,
				timestamp: createdAt,
				cwd: root,
			}),
		];
		if (activityAt) {
			lines.push(
				JSON.stringify({
					type: "message",
					id: `${name}-user`,
					parentId: null,
					timestamp: activityAt,
					message: {
						role: "user",
						content: name,
						timestamp: Date.parse(activityAt),
					},
				}),
			);
		}
		await writeFile(
			path.join(sessionsDirectory, `${name}.jsonl`),
			`${lines.join("\n")}\n`,
			"utf8",
		);
	};

	// The oldest session by creation time has the newest activity, so activity
	// must drive the ordering.
	await write(
		"old-created-new-activity",
		"2026-01-01T00:00:00.000Z",
		"2026-03-01T00:00:00.000Z",
	);
	await write(
		"new-created-old-activity",
		"2026-02-01T00:00:00.000Z",
		"2026-02-01T00:00:00.000Z",
	);
	await write("never-used", "2026-01-15T00:00:00.000Z", undefined);

	try {
		const sessions = await loaded.module.listProjectSessions(
			root,
			undefined,
			sessionsDirectory,
		);
		assert.deepEqual(
			sessions.map((session) => path.basename(session.path, ".jsonl")),
			["old-created-new-activity", "new-created-old-activity", "never-used"],
		);
		// The unused session has no message entry, so it has no excerpt to title
		// itself with and falls back to "Untitled" rather than borrowing a time.
		assert.equal(sessions[2].title, "Untitled");
		assert.equal(sessions[2].lastActivityAt, "2026-01-15T00:00:00.000Z");
	} finally {
		await loaded.dispose();
	}
});

test("session mutation guards refuse busy, restarted, and stale-workspace states", async () => {
	const loaded = await loadBundledModule({
		entry: "src/provider/sessionMutation.ts",
		name: "session-mutation",
	});
	try {
		const {
			sessionMutationBlockReason,
			assertSessionMutationAllowed,
			assertSessionMutationIdle,
		} = loaded.module;
		const idle = {
			clientIsRunning: true,
			clientMatches: true,
			workspaceGenerationMatches: true,
			isStreaming: false,
			isCompacting: false,
		};
		assert.equal(sessionMutationBlockReason(idle), undefined);
		assert.doesNotThrow(() => assertSessionMutationAllowed(idle));

		assert.match(
			sessionMutationBlockReason({ ...idle, isStreaming: true }),
			/Wait for pi to finish/u,
		);
		assert.match(
			sessionMutationBlockReason({ ...idle, isCompacting: true }),
			/compacting/u,
		);
		assert.match(
			sessionMutationBlockReason({ ...idle, clientMatches: false }),
			/Pi restarted/u,
		);
		assert.match(
			sessionMutationBlockReason({ ...idle, clientIsRunning: false }),
			/not running/u,
		);
		// A workspace switch outranks every other reason: the result must never be
		// written into a different workspace.
		assert.match(
			sessionMutationBlockReason({
				...idle,
				workspaceGenerationMatches: false,
				clientMatches: false,
				isStreaming: true,
			}),
			/Workspace changed/u,
		);

		// Metadata-only operations (deleting an inactive history file) may run while
		// pi is streaming, but identity checks still apply.
		assert.equal(
			sessionMutationBlockReason(
				{ ...idle, isStreaming: true, isCompacting: true },
				false,
			),
			undefined,
		);
		assert.match(
			sessionMutationBlockReason({ ...idle, clientMatches: false }, false),
			/Pi restarted/u,
		);

		assert.throws(() => assertSessionMutationIdle(true, false), /Wait for pi/u);
		assert.throws(() => assertSessionMutationIdle(false, true), /compacting/u);
		assert.doesNotThrow(() => assertSessionMutationIdle(false, false));
	} finally {
		await loaded.dispose();
	}
});
