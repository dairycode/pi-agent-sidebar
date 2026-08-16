import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
].sort();

const requiredCssRules = new Map([
	["base", "#app{"],
	["transcript", ".transcript{"],
	["sessions", ".history-panel{"],
	["commands", ".command-panel{"],
	["composer", ".composer-shell{"],
	["overlays", ".modal-backdrop{"],
	["responsive", "@media(max-width:320px)"],
]);

async function listGeneratedFiles(directory) {
	const entries = await readdir(path.join(directory, "dist"), {
		recursive: true,
		withFileTypes: true,
	});
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) =>
			path.join(
				"dist",
				path.relative(path.join(directory, "dist"), entry.parentPath),
				entry.name,
			),
		)
		.sort();
}

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

	const [firstFiles, secondFiles] = await Promise.all([
		listGeneratedFiles(first),
		listGeneratedFiles(second),
	]);
	const manifestIssues = [];
	for (const [label, files] of [
		["first", firstFiles],
		["second", secondFiles],
	]) {
		const missing = generated.filter((file) => !files.includes(file));
		const extra = files.filter((file) => !generated.includes(file));
		if (missing.length > 0) {
			manifestIssues.push(`${label} build missing: ${missing.join(", ")}`);
		}
		if (extra.length > 0) {
			manifestIssues.push(`${label} build added: ${extra.join(", ")}`);
		}
	}

	const drift = [];
	for (const relative of generated) {
		const [a, b] = await Promise.all([
			readFile(path.join(first, relative)).catch(() => undefined),
			readFile(path.join(second, relative)).catch(() => undefined),
		]);
		if (!a || !b || !a.equals(b)) drift.push(relative);
	}

	const productionCss = await readFile(
		path.join(first, "dist", "webview", "main.css"),
		"utf8",
	).catch(() => "");
	const missingCssComponents = [...requiredCssRules].flatMap(
		([component, rule]) => (productionCss.includes(rule) ? [] : [component]),
	);

	const errors = [
		...manifestIssues,
		...(drift.length > 0
			? [`Non-reproducible files: ${drift.join(", ")}`]
			: []),
		...(missingCssComponents.length > 0
			? [
					`Webview CSS is missing component rules: ${missingCssComponents.join(", ")}`,
				]
			: []),
	];
	if (errors.length > 0) {
		console.error(
			`Production build validation failed:\n${errors
				.map((entry) => `  - ${entry}`)
				.join("\n")}`,
		);
		process.exitCode = 1;
	} else {
		console.log("Production build is complete and reproducible.");
	}
} finally {
	await Promise.all([
		rm(first, { recursive: true, force: true }),
		rm(second, { recursive: true, force: true }),
	]);
}
