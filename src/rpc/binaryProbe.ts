/// <reference types="node" />

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MINIMUM_VERSION = [0, 81, 0] as const;

export interface BinaryProbeResult {
	version: string;
	warning?: string;
}

function compareVersion(left: number[], right: readonly number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

export async function probePiBinary(
	binary: string,
	cwd: string,
): Promise<BinaryProbeResult> {
	let stdout: string;
	try {
		const result = await execFileAsync(binary, ["--version"], {
			cwd,
			env: process.env,
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
		});
		stdout = result.stdout.trim();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Unable to run '${binary} --version'. Configure piAgentSidebar.binaryPath. ${detail}`,
		);
	}

	const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/u);
	if (!match)
		throw new Error(
			`'${binary} --version' returned an unrecognized version: ${stdout || "(empty)"}`,
		);

	const version = match[0];
	const parsed = match.slice(1).map(Number);
	return {
		version,
		warning:
			compareVersion(parsed, MINIMUM_VERSION) < 0
				? `Pi ${version} is older than the tested minimum 0.81.0. RPC behavior may be incompatible.`
				: undefined,
	};
}
