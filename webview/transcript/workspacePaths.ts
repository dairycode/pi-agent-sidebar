/**
 * Matches a workspace-relative path in transcript text, optionally followed by
 * `:line`.
 *
 * The lookbehind replaces a `\b`. `\b` treats the dot in `.vscode/settings.json`
 * and `.github/workflows/ci.yml` as a word boundary, so matching started after
 * it and the leading dot was dropped — those are exactly the paths pi emits
 * when it talks about configuration, and a path with a missing dot does not
 * open. Requiring the preceding character to be neither a word character nor a
 * path separator still keeps a match from starting inside a longer path: in
 * `a/src/app.ts` the match begins at `a`, not at `src`.
 */
export const WORKSPACE_PATH_PATTERN =
 /(?<![\w./\\-])([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z][\w]*)(?::(\d+))?/gu;
