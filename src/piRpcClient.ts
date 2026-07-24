/// <reference types="node" />

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { JsonRecord } from "./shared/protocol.js";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingRequest {
	command: string;
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
}

export interface PiRpcClientOptions {
	binary: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export class PiRpcClient {
	private readonly emitter = new EventEmitter();
	private readonly pending = new Map<string, PendingRequest>();
	private child: ChildProcessWithoutNullStreams | undefined;
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private discardingOversizedRecord = false;
	private stopping = false;

	public constructor(private readonly options: PiRpcClientOptions) {}

	public get isRunning(): boolean {
		return Boolean(
			this.child && this.child.exitCode === null && !this.child.killed,
		);
	}

	public onEvent(listener: (event: JsonRecord) => void): () => void {
		this.emitter.on("event", listener);
		return () => this.emitter.off("event", listener);
	}

	public onStderr(listener: (text: string) => void): () => void {
		this.emitter.on("stderr", listener);
		return () => this.emitter.off("stderr", listener);
	}

	public onProtocolError(listener: (message: string) => void): () => void {
		this.emitter.on("protocolError", listener);
		return () => this.emitter.off("protocolError", listener);
	}

	public onExit(listener: (exit: ProcessExit) => void): () => void {
		this.emitter.on("exit", listener);
		return () => this.emitter.off("exit", listener);
	}

	public async start(): Promise<void> {
		if (this.isRunning) return;

		this.stopping = false;
		this.decoder = new StringDecoder("utf8");
		this.buffer = "";
		this.discardingOversizedRecord = false;

		const child = spawn(this.options.binary, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env ?? process.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.stdout.on("data", (chunk: Buffer) => this.consumeChunk(chunk));
		child.stdout.on("end", () => this.finishDecoder());
		child.stderr.on("data", (chunk: Buffer) =>
			this.emitter.emit("stderr", chunk.toString("utf8")),
		);
		child.on("exit", (code, signal) => this.handleExit(code, signal));

		await new Promise<void>((resolve, reject) => {
			const onSpawn = (): void => {
				child.off("error", onStartError);
				child.on("error", onRuntimeError);
				resolve();
			};
			const onStartError = (error: Error): void => {
				child.off("spawn", onSpawn);
				this.child = undefined;
				reject(error);
			};
			const onRuntimeError = (error: Error): void => {
				this.emitter.emit(
					"protocolError",
					`Pi process error: ${error.message}`,
				);
			};
			child.once("spawn", onSpawn);
			child.once("error", onStartError);
		});
	}

	public async request<T = unknown>(
		command: JsonRecord,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<T> {
		if (!this.isRunning) throw new Error("Pi RPC process is not running.");

		const id = randomUUID();
		const commandName =
			typeof command.type === "string" ? command.type : "unknown";
		const response = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						`Pi RPC command '${commandName}' timed out after ${timeoutMs}ms.`,
					),
				);
			}, timeoutMs);
			this.pending.set(id, {
				command: commandName,
				resolve: (value) => resolve(value as T),
				reject,
				timer,
			});
		});

		try {
			await this.writeRecord({ ...command, id });
		} catch (error) {
			const pending = this.pending.get(id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}

		return response;
	}

	public async notify(command: JsonRecord): Promise<void> {
		if (!this.isRunning) throw new Error("Pi RPC process is not running.");
		await this.writeRecord(command);
	}

	public async stop(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null) return;

		this.stopping = true;
		try {
			await this.writeRecord({ type: "abort" });
		} catch {
			// The process may already be closing.
		}
		child.stdin.end();

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let terminateTimer: NodeJS.Timeout | undefined;
			let killTimer: NodeJS.Timeout | undefined;
			let failureTimer: NodeJS.Timeout | undefined;
			const cleanup = (): void => {
				if (terminateTimer) clearTimeout(terminateTimer);
				if (killTimer) clearTimeout(killTimer);
				if (failureTimer) clearTimeout(failureTimer);
				child.off("exit", finish);
			};
			const finish = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			child.once("exit", finish);
			terminateTimer = setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGTERM");
			}, 500);
			killTimer = setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 1_500);
			failureTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error("Pi RPC process did not exit after SIGKILL."));
			}, 3_000);
			terminateTimer.unref();
			killTimer.unref();
			failureTimer.unref();
			if (child.exitCode !== null) finish();
		});
	}

	private async writeRecord(record: JsonRecord): Promise<void> {
		const child = this.child;
		if (!child || !this.isRunning || child.stdin.destroyed) {
			throw new Error("Pi RPC stdin is unavailable.");
		}

		const payload = `${JSON.stringify(record)}\n`;
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(payload, "utf8", (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	private consumeChunk(chunk: Buffer): void {
		let decoded = this.decoder.write(chunk);

		if (this.discardingOversizedRecord) {
			const newline = decoded.indexOf("\n");
			if (newline < 0) return;
			decoded = decoded.slice(newline + 1);
			this.discardingOversizedRecord = false;
		}

		this.buffer += decoded;
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;

			if (
				Buffer.byteLength(this.buffer.slice(0, newline), "utf8") >
				MAX_RECORD_BYTES
			) {
				this.rejectPendingForOversizedRecord();
				this.buffer = this.buffer.slice(newline + 1);
				continue;
			}

			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.handleLine(line);
		}

		if (Buffer.byteLength(this.buffer, "utf8") > MAX_RECORD_BYTES) {
			this.buffer = "";
			this.discardingOversizedRecord = true;
			this.rejectPendingForOversizedRecord();
		}
	}

	private finishDecoder(): void {
		const trailing = this.decoder.end();
		if (trailing) this.buffer += trailing;
		if (this.buffer && !this.discardingOversizedRecord) {
			const line = this.buffer.endsWith("\r")
				? this.buffer.slice(0, -1)
				: this.buffer;
			this.handleLine(line);
		}
		this.buffer = "";
	}

	private handleLine(line: string): void {
		if (!line) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			this.emitter.emit(
				"protocolError",
				`Ignored malformed Pi RPC JSON: ${String(error)}`,
			);
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			this.emitter.emit("protocolError", "Ignored a non-object Pi RPC record.");
			return;
		}
		const record = parsed as JsonRecord;

		if (record.type === "response" && typeof record.id === "string") {
			const pending = this.pending.get(record.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(record.id);
			if (record.success === false) {
				pending.reject(
					new Error(
						typeof record.error === "string"
							? record.error
							: `${pending.command} failed.`,
					),
				);
			} else {
				pending.resolve(record.data);
			}
			return;
		}

		this.emitter.emit("event", record);
	}

	private rejectPendingForOversizedRecord(): void {
		const error = new Error(
			`Pi RPC record exceeded the ${MAX_RECORD_BYTES / (1024 * 1024)} MB safety limit.`,
		);
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
		this.emitter.emit("protocolError", error.message);
	}

	private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.child = undefined;
		const suffix = this.stopping
			? "stopped"
			: `exited (code ${String(code)}, signal ${String(signal)})`;
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(
				new Error(
					`Pi RPC process ${suffix} before '${request.command}' completed.`,
				),
			);
		}
		this.pending.clear();
		this.emitter.emit("exit", { code, signal } satisfies ProcessExit);
	}
}
