import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { findChrome } from "../../scripts/preview/browser.mjs";
import { loadDocumentFactory } from "../../scripts/preview/document.mjs";

const run = promisify(execFile);

// This is deliberately a real entry-point test: isolated controller tests cannot
// catch initialization order failures or messages ignored by the window listener.
test("webview boots, streams, switches sessions and handles session/composer UI in Chrome", { timeout: 90000 }, async (t) => {
 let chrome;
 try { chrome = await findChrome(); } catch (error) { t.skip(error.message); return; }
 const directory = await mkdtemp(path.join(os.tmpdir(), "pi-sidebar-browser-test-"));
 t.after(() => rm(directory, { recursive: true, force: true }));
 // Build the complete asset tree in isolation: a clean checkout has no dist,
 // and an existing workspace build may contain stale styles or scripts.
 await run(process.execPath, ["scripts/build.mjs", `--out-dir=${directory}`], { timeout: 60000 });
 const factory = await loadDocumentFactory(directory);
 const uri = (file) => { const url = pathToFileURL(file).href; return { toString: () => url, with: () => url }; };
 let html = factory({ cspSource: "file:", asWebviewUri: (value) => uri(value.fsPath) }, { fsPath: directory });
 const nonce = /nonce-([A-Za-z0-9_-]+)/u.exec(html)[1];
 const scenario = await readFile(new URL("../fixtures/webview-refactor-scenario.js", import.meta.url), "utf8");
 html = html.replace(/<body([^>]*)>/u, (_match, attributes) => `<body${attributes}><script nonce="${nonce}">${scenario}</script>`);
 const file = path.join(directory, "index.html");
 await writeFile(file, html);
 const { stdout } = await run(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--allow-file-access-from-files", "--virtual-time-budget=12000", "--dump-dom", pathToFileURL(file).href], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
 const failure = /data-test-error="([^"]*)"/u.exec(stdout)?.[1];
 assert.equal(failure, undefined, failure);
 assert.match(stdout, /data-test-complete="true"/u, "the real webview must complete its handshake and scenario");
});
