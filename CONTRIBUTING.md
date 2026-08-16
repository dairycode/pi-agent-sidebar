# Contributing

Thanks for helping improve Pi Agent Sidebar. Contributions of all sizes are welcome, from documentation fixes to new VS Code integrations.

## Before You Start

Small bug fixes and focused improvements can be submitted directly. Please open
an issue before starting a large UI change, protocol change, dependency change,
or architectural refactor so the approach can be discussed first.

Pi Agent Sidebar is intentionally a thin VS Code client around pi. A change
should improve the sidebar experience or provide context that only VS Code has.
It should not reimplement agent behavior already provided by pi or depend on
pi's private implementation details.

## Requirements

- Node.js 22
- npm
- VS Code 1.129 or newer
- `pi` 0.81.0 or newer for manual runtime testing
- A trusted VS Code workspace

Install pi when runtime testing is needed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
/login
```

## Development Setup

1. Fork and clone the repository.
2. Install the exact dependency versions from the lockfile:

   ```bash
   npm ci
   ```

3. Build the extension and Webview bundles:

   ```bash
   npm run build
   ```

4. Open the repository in VS Code and press `F5`, or run the
   **Run Pi Agent Extension** launch configuration. This starts an Extension
   Development Host with the local extension.

For continuous development, run:

```bash
npm run watch
```

Use `npm run preview` when working on Webview presentation without repeatedly
launching an Extension Development Host.

## Useful Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build development extension and Webview bundles. |
| `npm run watch` | Rebuild both bundles when source files change. |
| `npm run typecheck` | Run TypeScript without emitting files. |
| `npm run test:unit` | Run the unit test suite. |
| `npm run verify` | Run type checks, unit tests, and reproducible-build checks. |
| `npm run preview` | Start the local Webview preview harness. |
| `npm run package` | Validate, build, and create a VSIX package. |

Run `npm run verify` before submitting a pull request.

## Project Structure

- `src/extension.ts` — VS Code extension entry point.
- `src/provider/` — Webview provider and serialized provider operations.
- `src/rpc/` — pi process probing, RPC transport, and response validation.
- `src/services/` — attachments, prompt construction, sessions, and workspace
  resources.
- `src/webviewDocument.ts` — Host-side Webview HTML and Content Security Policy.
- `webview/composer/` — browser-side composer state and reference ranges.
- `webview/transcript/` — transcript rendering and streaming delta assembly.
- `webview/main.ts`, `webview/main.css`, and `webview/resourceDrop.ts` — Webview
  entry point, styles, and drag-and-drop parsing.
- `shared/` — platform-neutral protocol types and composer reference helpers used
  by both the Extension Host and Webview.
- `assets/` — source-controlled extension icons.
- `scripts/` — tests, build scripts, preview tooling, and RPC fixtures.
- `dist/extension.js` and `dist/webview/` — generated build outputs; do not edit
  or commit them manually.

## Design and Security Guidelines

- Use pi's public RPC protocol. Do not rely on private tool argument shapes or
  internal pi behavior.
- Prefer forwarding pi's output over recreating behavior in the client.
- Treat all Webview messages, RPC events, file paths, URIs, and persisted state
  as untrusted input. Validate and bound data at the receiving boundary.
- Keep filesystem and resource access within the trusted VS Code workspace
  unless a feature has an explicit, reviewed reason to do otherwise.
- Preserve compatibility with local, remote, and multi-root workspaces when
  handling `vscode.Uri` values. Do not reconstruct a resource from a display
  label when its canonical URI is available.
- Keep extension-host code separate from browser-only Webview code. Shared
  modules must remain safe for every runtime that imports them.
- Add or update tests for behavior changes, especially protocol validation and
  resource-boundary changes.
- Update `CHANGELOG.md` for user-visible changes.
- Never commit credentials, session transcripts, workspace data, or local VSIX
  packages.

See `AGENT.md` for the project's design principles and scope.

## Tests

Tests use Node's built-in test runner and live under `scripts/` as
`*.test.mjs`. Keep tests focused on observable behavior. Pure functions are
preferred for URI resolution, validation, state reconciliation, and payload
construction because they can be tested without a running VS Code instance.

If a change cannot be covered automatically, describe the manual validation in
the pull request. UI changes should include a screenshot or short recording
when practical.

## Pull Requests

- Keep each pull request focused on one problem.
- Explain the user-visible behavior and why the change is needed.
- Avoid mixing functional changes with broad formatting or unrelated refactors.
- Include tests for fixes and new behavior when practical.
- Complete the pull request template and list the commands you ran.
- Ensure CI passes before requesting review.
- Respond to review feedback with follow-up commits; maintainers may squash the
  pull request when merging.

Maintainers may ask to move a large or unrelated part of a change into a
follow-up pull request. This keeps reviews understandable and releases easy to
revert.
