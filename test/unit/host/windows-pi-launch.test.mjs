import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

const PI_PACKAGE_SEGMENTS = ["@earendil-works", "pi-coding-agent"];
const DEFAULT_BIN = path.join("dist", "bundle", "cli.js");

async function loadWindowsPiLaunch() {
	return loadBundledModule({
		entry: "src/rpc/windowsPiLaunch.ts",
		name: "windows-pi-launch",
	});
}

/**
 * Creates a temp root, points APPDATA at it (the resolver reads that env var
 * directly), runs the assertion, then restores env and cleans up. The
 * `where.exe` and `npm root -g` lookups are injected instead, so these tests
 * exercise the real resolution logic on every platform.
 */
async function withTemporaryRoot(run) {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-sidebar-winlaunch-"));
	const appData = path.join(root, "AppData", "Roaming");
	const previous = process.env.APPDATA;
	process.env.APPDATA = appData;
	try {
		return await run({ root, appData });
	} finally {
		if (previous === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = previous;
		await rm(root, { recursive: true, force: true });
	}
}

async function writeFileAt(filePath, contents = "") {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
	return filePath;
}

/** Installs a fake pi package under `nodeModulesRoot`, honoring its bin field. */
async function installPi(nodeModulesRoot, { bin = DEFAULT_BIN } = {}) {
	const packageDirectory = path.join(nodeModulesRoot, ...PI_PACKAGE_SEGMENTS);
	await writeFileAt(
		path.join(packageDirectory, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			bin: { pi: bin },
		}),
	);
	return writeFileAt(path.join(packageDirectory, bin));
}

async function fakeNode(root) {
	return writeFileAt(path.join(root, "nodejs", "node.exe"));
}

function deps({ nodeCandidates = [], npmGlobalRoot } = {}) {
	let npmGlobalRootCalls = 0;
	return {
		nodeCandidates: () => Promise.resolve(nodeCandidates),
		npmGlobalRoot: () => {
			npmGlobalRootCalls += 1;
			return Promise.resolve(npmGlobalRoot);
		},
		get npmGlobalRootCalls() {
			return npmGlobalRootCalls;
		},
	};
}

test("resolves node plus the pi entry from npm's APPDATA global root", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root, appData }) => {
			const nodeExecutable = await fakeNode(root);
			const cli = await installPi(path.join(appData, "npm", "node_modules"));
			const injected = deps({ nodeCandidates: [nodeExecutable] });

			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: injected,
			});
			assert.deepEqual(launch, {
				binary: nodeExecutable,
				prependArgs: [cli],
			});
			assert.equal(
				injected.npmGlobalRootCalls,
				0,
				"the slow npm query must be skipped once a well-known root hits",
			);
		});
	} finally {
		await loaded.dispose();
	}
});

test("resolves a pi install next to node.exe (MSI-style layout)", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root }) => {
			const nodeExecutable = await fakeNode(root);
			const cli = await installPi(
				path.join(path.dirname(nodeExecutable), "node_modules"),
			);

			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({ nodeCandidates: [nodeExecutable] }),
			});
			assert.deepEqual(launch, {
				binary: nodeExecutable,
				prependArgs: [cli],
			});
		});
	} finally {
		await loaded.dispose();
	}
});

test("falls back to 'npm root -g' when the well-known roots miss", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root }) => {
			const nodeExecutable = await fakeNode(root);
			const npmRoot = path.join(root, "custom-prefix", "node_modules");
			const cli = await installPi(npmRoot);

			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({
					nodeCandidates: [nodeExecutable],
					npmGlobalRoot: npmRoot,
				}),
			});
			assert.deepEqual(launch, {
				binary: nodeExecutable,
				prependArgs: [cli],
			});
		});
	} finally {
		await loaded.dispose();
	}
});

test("honors the package's own bin field instead of a hardcoded bundle path", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root, appData }) => {
			const nodeExecutable = await fakeNode(root);
			const cli = await installPi(path.join(appData, "npm", "node_modules"), {
				bin: path.join("build", "entry.mjs"),
			});

			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({ nodeCandidates: [nodeExecutable] }),
			});
			assert.deepEqual(launch?.prependArgs, [cli]);
		});
	} finally {
		await loaded.dispose();
	}
});

test("skips node candidates that do not exist", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root, appData }) => {
			const nodeExecutable = await fakeNode(root);
			await installPi(path.join(appData, "npm", "node_modules"));

			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({
					nodeCandidates: [
						path.join(root, "missing", "node.exe"),
						nodeExecutable,
					],
				}),
			});
			assert.equal(launch?.binary, nodeExecutable);
		});
	} finally {
		await loaded.dispose();
	}
});

test("ignores a directory that shadows the node executable name", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root, appData }) => {
			const shadow = path.join(root, "shadow", "node.exe");
			await mkdir(shadow, { recursive: true });
			await installPi(path.join(appData, "npm", "node_modules"));

			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({ nodeCandidates: [shadow] }),
			});
			assert.equal(launch, undefined);
		});
	} finally {
		await loaded.dispose();
	}
});

test("returns undefined when no node executable exists", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ appData }) => {
			await installPi(path.join(appData, "npm", "node_modules"));
			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({ nodeCandidates: [] }),
			});
			assert.equal(launch, undefined);
		});
	} finally {
		await loaded.dispose();
	}
});

test("returns undefined when node exists but pi is not installed", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root }) => {
			const nodeExecutable = await fakeNode(root);
			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({ nodeCandidates: [nodeExecutable] }),
			});
			assert.equal(launch, undefined);
		});
	} finally {
		await loaded.dispose();
	}
});

test("returns undefined when the pi package.json declares no usable bin", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root, appData }) => {
			const nodeExecutable = await fakeNode(root);
			await writeFileAt(
				path.join(
					appData,
					"npm",
					"node_modules",
					...PI_PACKAGE_SEGMENTS,
					"package.json",
				),
				JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
			);

			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({ nodeCandidates: [nodeExecutable] }),
			});
			assert.equal(launch, undefined);
		});
	} finally {
		await loaded.dispose();
	}
});

test("returns undefined when the bin field points at a missing file", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		await withTemporaryRoot(async ({ root, appData }) => {
			const nodeExecutable = await fakeNode(root);
			await writeFileAt(
				path.join(
					appData,
					"npm",
					"node_modules",
					...PI_PACKAGE_SEGMENTS,
					"package.json",
				),
				JSON.stringify({ bin: { pi: DEFAULT_BIN } }),
			);

			const launch = await loaded.module.resolveWindowsPiLaunch({
				deps: deps({ nodeCandidates: [nodeExecutable] }),
			});
			assert.equal(launch, undefined);
		});
	} finally {
		await loaded.dispose();
	}
});

test("reuses the cached default resolution until it is refreshed", async () => {
	const loaded = await loadWindowsPiLaunch();
	try {
		// The default deps shell out to Windows-only executables, so assert on the
		// promise identity rather than the resolved value: that is what proves the
		// `where.exe` / `npm root -g` round trip is not repeated per start.
		const first = loaded.module.resolveWindowsPiLaunch();
		const second = loaded.module.resolveWindowsPiLaunch();
		assert.equal(first, second, "a second call must reuse the cached promise");
		await first;
		const refreshed = loaded.module.resolveWindowsPiLaunch({ refresh: true });
		assert.notEqual(refreshed, first, "refresh must re-resolve");
		await refreshed;
	} finally {
		await loaded.dispose();
	}
});
