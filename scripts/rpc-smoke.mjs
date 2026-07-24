import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const binary = process.env.PI_BINARY || "pi";
const child = spawn(binary, ["--mode", "rpc", "--no-session", "--offline", "--no-approve"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

const decoder = new StringDecoder("utf8");
let buffer = "";
let stderr = "";
let settled = false;

const finish = (error) => {
  if (settled) return;
  settled = true;
  child.stdin.end();
  child.kill("SIGTERM");
  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Pi RPC smoke test passed.");
  }
};

const timer = setTimeout(() => finish(`Timed out waiting for ${binary} RPC state.\n${stderr}`), 15_000);
timer.unref();

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

child.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      finish(`Invalid RPC JSON: ${String(error)}`);
      return;
    }
    if (record.id === "smoke-state") {
      clearTimeout(timer);
      finish(record.success ? undefined : `get_state failed: ${record.error ?? "unknown error"}`);
      return;
    }
  }
});

child.once("error", (error) => finish(`Unable to start ${binary}: ${error.message}`));
child.once("exit", (code) => {
  if (!settled) finish(`${binary} exited early with code ${String(code)}.\n${stderr}`);
});

child.stdin.write(`${JSON.stringify({ id: "smoke-state", type: "get_state" })}\n`);
