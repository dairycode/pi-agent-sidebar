import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

export async function findChrome() {
	for (const candidate of CHROME_CANDIDATES) {
		try {
			await run(candidate, ["--version"], { timeout: 15_000 });
			return candidate;
		} catch {
			// Try the next candidate.
		}
	}
	throw new Error(
		`No Chrome/Chromium found. Looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`,
	);
}

export async function validatePreview(chrome, chromeArgs, pageUrl) {
	const validation = await run(
		chrome,
		[...chromeArgs, "--dump-dom", pageUrl],
		{ timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
	);
	const previewError = /data-preview-error="([^"]+)"/u.exec(
		validation.stdout,
	)?.[1];
	if (previewError) {
		throw new Error(`Preview validation failed: ${previewError}`);
	}
	if (!validation.stdout.includes('data-preview-ready="true"')) {
		throw new Error(
			"Preview validation failed: webview did not reach its ready state",
		);
	}
}

export async function capturePreview(chrome, chromeArgs, pageUrl, output) {
	await run(chrome, [...chromeArgs, `--screenshot=${output}`, pageUrl], {
		timeout: 60_000,
	});
	await access(output);
}
