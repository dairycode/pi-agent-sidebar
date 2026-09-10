/**
 * Build entry for the mermaid bundle.
 *
 * Mermaid and its dependencies are several megabytes, so they get their own
 * bundle (`dist/webview/mermaid.js`) instead of riding along with the webview's
 * main bundle: `enhanceMermaidBlocks` injects this script the first time a
 * diagram appears, and a session that never shows one never parses it.
 *
 * The library is handed over on a global rather than through a module import
 * because the webview is a classic script (an ES module would be subject to
 * CORS, which the preview's `file://` document cannot satisfy).
 */
import mermaid from "mermaid";

(globalThis as { __piMermaid?: unknown }).__piMermaid = mermaid;
