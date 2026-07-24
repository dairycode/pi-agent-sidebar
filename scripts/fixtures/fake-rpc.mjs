import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
let buffer = "";

process.stdout.write("null\n");

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
