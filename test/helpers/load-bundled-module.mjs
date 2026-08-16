import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export const projectRoot = process.cwd();

/**
 * Bundles one TypeScript module for isolated Node test loading.
 *
 * Browser-targeted modules still load in Node after bundling; tests provide any
 * DOM globals they need. Callers retain ownership of explicit esbuild plugins
 * so module-specific mocks remain visible in the test that uses them.
 */
export async function loadBundledModule({
	entry,
	name = path.basename(entry, path.extname(entry)),
	platform = "node",
	target = platform === "browser" ? "chrome120" : "node22",
	plugins = [],
	external = [],
	define,
}) {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), `pi-sidebar-${name}-test-`),
	);
	const output = path.join(temporaryDirectory, "bundle", `${name}.mjs`);
	try {
		await mkdir(path.dirname(output), { recursive: true });
		await build({
			entryPoints: [path.resolve(projectRoot, entry)],
			outfile: output,
			bundle: true,
			platform,
			format: "esm",
			target,
			logLevel: "silent",
			plugins,
			external,
			define,
		});
		return {
			module: await import(
				`${pathToFileURL(output).href}?v=${Date.now()}-${Math.random()}`
			),
			temporaryDirectory,
			dispose: () =>
				rm(temporaryDirectory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(temporaryDirectory, { recursive: true, force: true });
		throw error;
	}
}
