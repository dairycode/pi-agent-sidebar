# Pi Agent for VS Code

A VS Code auxiliary-sidebar client for [pi](https://pi.dev), built on pi's
RPC protocol. It keeps the agent process in the extension host and renders the
conversation in a theme-aware Webview.

Source: <https://github.com/dairycode/pi-agent-sidebar>

## Preview

![Pi Agent Sidebar running in the VS Code auxiliary sidebar](https://origin.picgo.net/2026/07/24/pi-agentfa95417444d05cd6.png)

## Features

- Streams assistant text, reasoning, and tool execution in the auxiliary sidebar
- Supports persistent sessions, history, new sessions, and reload restoration
- Switches configured models and supported thinking levels
- Queues steering prompts while pi is working and can abort the active run
- Attaches project files by path and sends supported image formats to models
- Inserts selected editor code as an inline `@path#line` composer reference
- Handles pi extension dialogs with native VS Code UI
- Uses Workspace Trust, strict JSONL, sanitized Markdown, and a restrictive CSP

## Editor Selection Shortcut

Select code in the editor, then press `Cmd+Esc` on macOS or `Ctrl+Esc` on
Windows and Linux. Pi Agent opens, focuses the composer, and inserts an
accent-colored inline reference such as `@src/file.ts#10-14` at the caret while
retaining the exact selected text as code context. Delete the reference text
to detach it. To
reopen the source, `Cmd`/`Ctrl`-click the marker or place the caret inside it
and press `F12`. With no editor selection, the shortcut only focuses the
composer.

Other AI extensions may use the same shortcut. Reassign **Pi Agent: Focus Input
with Selection** in VS Code's Keyboard Shortcuts editor when needed.

## Requirements

- VS Code 1.129 or newer
- `pi` 0.81.0 or newer installed and authenticated
- A trusted workspace folder

Install pi if needed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
/login
```

If VS Code cannot find `pi`, set `piAgentSidebar.binaryPath` to an absolute
path such as `/opt/homebrew/bin/pi`.

`piAgentSidebar.sessionDirectory` accepts an absolute path or a path relative
to the active workspace folder; the same resolved directory is used for pi's
session storage and the sidebar's history and deletion.

## Development

```bash
npm install
npm run verify
npm run build
```

`npm test` runs the type check and the hermetic unit suite; it does not require
an installed `pi`. `npm run verify` additionally rebuilds the tracked-free
bundles and checks them for drift. Run `npm run test:rpc:live` to exercise a
real installed `pi` runtime. Generated bundles (`dist/`, `media/main.js`,
`media/codicons/`) are produced by `npm run build` and are not committed.

Press `F5` in VS Code to launch an Extension Development Host. The view is
contributed directly to the Secondary Side Bar.

Build a VSIX:

```bash
npm run package
```

## Security Model

Pi's default coding tools can read, edit, and execute files with the extension
host user's permissions. This extension does not sandbox pi. It remains
disabled in untrusted workspaces, runs the configured binary without a shell,
and only passes `--approve` for project-local pi resources after VS Code has
established workspace trust.

Session files are managed by pi under `~/.pi/agent/sessions`. They can contain
source code, tool output, and other sensitive conversation data.
