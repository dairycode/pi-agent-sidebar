import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const generated = [
	path.join("dist", "extension.js"),
	path.join("dist", "webview", "main.js"),
	path.join("dist", "webview", "main.css"),
	path.join("dist", "webview", "codicons", "codicon.css"),
	path.join("dist", "webview", "codicons", "codicon.ttf"),
];

function buildInto(directory) {
	execFileSync(
		process.execPath,
		[
			path.join(root, "scripts", "build.mjs"),
			"--production",
			`--out-dir=${directory}`,
		],
		{ cwd: root, stdio: "inherit" },
	);
}

const first = await mkdtemp(path.join(os.tmpdir(), "pi-sidebar-generated-a-"));
const second = await mkdtemp(path.join(os.tmpdir(), "pi-sidebar-generated-b-"));
try {
	buildInto(first);
	buildInto(second);

	const drift = [];
	for (const relative of generated) {
		const [a, b] = await Promise.all([
			readFile(path.join(first, relative)).catch(() => undefined),
			readFile(path.join(second, relative)).catch(() => undefined),
		]);
		if (!a || !b || !a.equals(b)) drift.push(relative);
	}

	if (drift.length > 0) {
		console.error(
			`Production build is not reproducible:\n${drift
				.map((entry) => `  - ${entry}`)
				.join("\n")}`,
		);
		process.exit(1);
	}
	console.log("Production build is reproducible.");
} finally {
	await Promise.all([
		rm(first, { recursive: true, force: true }),
		rm(second, { recursive: true, force: true }),
	]);
}
