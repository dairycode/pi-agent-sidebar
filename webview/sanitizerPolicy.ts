import type { Config } from "dompurify";

/**
 * The one DOMPurify policy every transcript HTML fragment passes through.
 *
 * Two entry points sanitize transcript HTML: `transcript/renderer.ts` sanitizes
 * the markdown it renders, and `main.ts` re-parses already-rendered fragments
 * into nodes. They share this policy so that safety cannot depend on which path
 * a fragment happened to take.
 *
 * `style` is forbidden in both forms. DOMPurify's html profile allows the
 * `<style>` tag and the `style=` attribute, and the webview CSP must keep
 * `'unsafe-inline'` for styles because mermaid's SVG carries its own. Allowing
 * either would let any text that reaches the transcript repaint the composer,
 * the connection banner, or a dialog. `script-src` is nonce-only, so script
 * execution was already blocked; this closes the CSS surface.
 *
 * `data-copy-code` is deliberately absent: the copy button is built with DOM
 * APIs after sanitizing, and no path re-serializes the DOM back into HTML, so
 * the attribute never appears in sanitized input.
 *
 * Shared by reference is safe: DOMPurify reads the configuration and clones the
 * array values it keeps, so a sanitize call cannot mutate this object.
 *
 * `satisfies` rather than an annotation: a `Config`-typed value widens
 * `RETURN_TRUSTED_TYPE`, which makes DOMPurify's overloads resolve to the
 * `TrustedHTML` signature and breaks every string-returning caller.
 */
export const TRANSCRIPT_SANITIZE_OPTIONS = {
 USE_PROFILES: { html: true },
 ADD_ATTR: ["target", "rel"],
 FORBID_TAGS: ["style"],
 FORBID_ATTR: ["style"],
} satisfies Config;
