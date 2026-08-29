import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
let buffer = "";

process.stdout.write("null\n");

/** Shapes captured from a live `pi --mode rpc` 0.84.3 probe. */
const FORK_MESSAGES = {
	messages: [
		{ entryId: "user-one", text: "First prompt" },
		{ entryId: "user-two", text: "Second prompt" },
	],
};

const ENTRIES = {
	entries: [
		{
			type: "message",
			id: "user-one",
			parentId: null,
			timestamp: "2026-01-02T03:04:01.000Z",
			message: {
				role: "user",
				content: "First prompt",
				timestamp: 1767323041000,
			},
		},
		{
			type: "message",
			id: "assistant-one",
			parentId: "user-one",
			timestamp: "2026-01-02T03:04:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "First answer" }],
				timestamp: 1767323042000,
				stopReason: "stop",
			},
		},
		{
			type: "session_info",
			id: "info-one",
			parentId: "assistant-one",
			timestamp: "2026-01-02T03:04:05.000Z",
			name: "Probe",
		},
	],
	leafId: "info-one",
};

const TREE = {
	tree: [
		{
			entry: ENTRIES.entries[0],
			children: [
				{
					entry: ENTRIES.entries[1],
					children: [{ entry: ENTRIES.entries[2], children: [] }],
				},
			],
		},
	],
	leafId: "info-one",
};

function respond(command, payload) {
	process.stdout.write(
		`${JSON.stringify({
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			data: payload,
		})}\n`,
	);
}

process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline).replace(/\r$/u, "");
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		let command;
		try {
			command = JSON.parse(line);
		} catch {
			continue;
		}
		if (!command || typeof command !== "object") continue;
		if (command.type === "hang" || command.type === "abort") continue;
		if (command.type === "exit_now") {
			process.exitCode = 7;
			process.stdin.destroy();
			return;
		}
		if (command.type === "get_fork_messages") {
			respond(command, FORK_MESSAGES);
			continue;
		}
		if (command.type === "get_entries") {
			respond(command, ENTRIES);
			continue;
		}
		if (command.type === "get_tree") {
			respond(command, TREE);
			continue;
		}
		if (command.type === "cancelled_mutation") {
			respond(command, { cancelled: true });
			continue;
		}
		// A response whose `command` disagrees with the request must be refused
		// rather than resolved against the wrong pending request.
		if (command.type === "mismatched_command") {
			process.stdout.write(
				`${JSON.stringify({
					id: command.id,
					type: "response",
					command: "some_other_command",
					success: true,
					data: {},
				})}\n`,
			);
			continue;
		}
		if (command.type === "invalid_success") {
			process.stdout.write(
				`${JSON.stringify({
					id: command.id,
					type: "response",
					command: "invalid_success",
					success: "yes",
					data: {},
				})}\n`,
			);
			continue;
		}
		if (command.type === "unidentified_response") {
			// Missing `id`: must be ignored as a protocol error, never matched to a
			// pending request by position.
			process.stdout.write(
				`${JSON.stringify({
					type: "response",
					command: "unidentified_response",
					success: true,
					data: {},
				})}\n`,
			);
			continue;
		}
		if (command.type === "get_state") {
			const payload = Buffer.from(
				`${JSON.stringify({
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: { sessionName: "snow 雪\u2028pi", isStreaming: false },
				})}\n`,
				"utf8",
			);
			const snow = Buffer.from("雪", "utf8");
			const snowIndex = payload.indexOf(snow);
			const split =
				snowIndex >= 0 ? snowIndex + 1 : Math.floor(payload.length / 2);
			process.stdout.write(payload.subarray(0, split));
			queueMicrotask(() => process.stdout.write(payload.subarray(split)));
		}
	}
});

process.stdin.on("end", () => {
	buffer += decoder.end();
	process.exit(0);
});
