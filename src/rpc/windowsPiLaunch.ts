import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER = 1024 * 1024;

/** The global npm package that ships the `pi` command. */
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_SEGMENTS = ["@earendil-works", "pi-coding-agent"] as const;

export interface WindowsPiLaunch {
	binary: string;
	prependArgs: string[];
}

/**
 * External lookups the resolver needs. Injectable so the resolution logic is
 * testable on every platform: the real implementations shell out to `where.exe`
 * and `cmd.exe`, which only exist on Windows and would otherwise answer from
 * the host's own node/npm install.
 */
export interface WindowsPiLaunchDeps {
	/** Absolute node executable candidates, best match first. */
	nodeCandidates(): Promise<string[]>;
	/** npm's global `node_modules` root, when npm can be queried. */
	npmGlobalRoot(): Promise<string | undefined>;
}

async function isFile(candidate: string): Promise<boolean> {
	try {
		const stats = await stat(candidate);
		return stats.isFile();
	} catch {
		return false;
	}
}

function firstLines(stdout: string): string[] {
	return stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

const defaultDeps: WindowsPiLaunchDeps = {
	async nodeCandidates(): Promise<string[]> {
		const candidates: string[] = [];
		try {
			const result = await execFileAsync("where.exe", ["node"], {
				env: process.env,
				timeout: EXEC_TIMEOUT_MS,
				maxBuffer: EXEC_MAX_BUFFER,
				windowsHide: true,
			});
			candidates.push(...firstLines(result.stdout));
		} catch {
			// Fall through to the usual install locations when `where` is
			// unavailable or node is not on PATH.
		}
		for (const programFiles of [
			process.env.ProgramFiles,
			process.env["ProgramFiles(x86)"],
		]) {
			if (programFiles) {
				candidates.push(path.join(programFiles, "nodejs", "node.exe"));
			}
		}
		return candidates;
	},
	async npmGlobalRoot(): Promise<string | undefined> {
		// npm itself is a `.cmd` shim, so it has to be run through cmd.exe.
		try {
			const result = await execFileAsync(
				"cmd.exe",
				["/c", "npm", "root", "-g"],
				{
					env: process.env,
					timeout: EXEC_TIMEOUT_MS,
					maxBuffer: EXEC_MAX_BUFFER,
					windowsHide: true,
				},
			);
			return firstLines(result.stdout)[0];
		} catch {
			return undefined;
		}
	},
};

/**
 * Resolves the pi entry script from an install directory by reading the
 * package's own `bin` field. `bin` is npm's public contract, unlike the
 * bundle layout underneath it.
 */
async function resolvePiEntry(
	nodeModulesRoot: string,
): Promise<string | undefined> {
	const packageDirectory = path.join(nodeModulesRoot, ...PI_PACKAGE_SEGMENTS);
	let manifest: unknown;
	try {
		manifest = JSON.parse(
			await readFile(path.join(packageDirectory, "package.json"), "utf8"),
		);
	} catch {
		return undefined;
	}
	if (typeof manifest !== "object" || manifest === null) return undefined;
	const bin = (manifest as { bin?: unknown }).bin;
	let relative: unknown;
	if (typeof bin === "string") relative = bin;
	else if (typeof bin === "object" && bin !== null) {
		relative = (bin as Record<string, unknown>).pi;
	}
	if (typeof relative !== "string" || relative.length === 0) return undefined;
	const entry = path.join(packageDirectory, relative);
	return (await isFile(entry)) ? entry : undefined;
}

async function resolve(
	deps: WindowsPiLaunchDeps,
): Promise<WindowsPiLaunch | undefined> {
	let nodeExecutable: string | undefined;
	for (const candidate of await deps.nodeCandidates()) {
		if (await isFile(candidate)) {
			nodeExecutable = candidate;
			break;
		}
	}
	if (!nodeExecutable) return undefined;

	// npm's default global root first, then a node install that carries its own
	// global node_modules (the Windows MSI layout).
	const roots: string[] = [];
	if (process.env.APPDATA) {
		roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
	}
	roots.push(path.join(path.dirname(nodeExecutable), "node_modules"));
	for (const root of roots) {
		const entry = await resolvePiEntry(root);
		if (entry) return { binary: nodeExecutable, prependArgs: [entry] };
	}

	// Only ask npm when the well-known locations miss: it is the slow path.
	const npmRoot = await deps.npmGlobalRoot();
	if (npmRoot) {
		const entry = await resolvePiEntry(npmRoot);
		if (entry) return { binary: nodeExecutable, prependArgs: [entry] };
	}
	return undefined;
}

let cached: Promise<WindowsPiLaunch | undefined> | undefined;

/**
 * Locates a Windows launch that avoids npm's `.cmd` shims: node.exe plus the
 * global pi entry script as its first argument. Returns undefined when no node
 * executable or pi install can be found.
 *
 * The result is cached because resolution shells out to `where.exe` and
 * possibly `npm root -g`; `refresh` re-resolves so an explicit pi restart
 * picks up an install that landed after the last attempt. Not `async`: the
 * cached promise itself is returned so repeat callers share one resolution.
 */
export function resolveWindowsPiLaunch(
	options: { refresh?: boolean; deps?: Partial<WindowsPiLaunchDeps> } = {},
): Promise<WindowsPiLaunch | undefined> {
	if (options.deps) return resolve({ ...defaultDeps, ...options.deps });
	if (options.refresh) cached = undefined;
	cached ??= resolve(defaultDeps);
	return cached;
}
