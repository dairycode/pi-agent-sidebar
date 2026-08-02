# Changelog

## 0.3.2

- Ease the density of long answers: give headings a real size step
  (1.26 / 1.13 / 1.02em, where an `h3` used to render at exactly body size),
  separate the three spacing levels (12px between paragraphs, 20px between
  messages, up from 9px and 15px), space out consecutive and nested list items,
  and settle body line height on a single 1.65 value shared by user text,
  assistant text, reasoning, and code blocks.
- Collapse the 10/11/12px chrome sizes onto one `--pi-font-chrome` step for an
  even 11 / 13 / 15 scale; icons keep their own size.
- Drop the tint from inline code in assistant, reasoning, and system messages,
  keeping only its faint background. `color` is set explicitly rather than
  omitted because VS Code injects a base `code` rule painting
  `--vscode-textPreformat-foreground`, which many themes define as a warm accent
  (One Dark Pro Darker uses #d19a66).
- Wrap message text with `break-word` instead of `anywhere`, so identifiers are
  no longer split mid-word.
- Keep the trusted-domain prompt working for links in the transcript. VS Code's
  injected anchor handler opens links with `fromWorkspace: true`, and its
  validator returns early for that flag in a trusted workspace
  (`workbench.trustedDomains.promptInTrustedWorkspace` defaults to false), so it
  never prompts. Links route through the host instead, and the click stops
  propagating so that handler cannot also open them unprompted.

## 0.3.1

- Pin the code block copy button to the top-right corner so horizontal
  scrolling no longer drags it along with the code.

## 0.3.0

- Add a `Pi Agent` editor context submenu with preset prompts for explaining a
  selection, refactoring, generating tests, explaining reported problems, and
  explaining the whole file.
- Add a `Fix with Pi` quick fix that forwards the diagnostic under the cursor,
  and include diagnostics plus the enclosing symbol in editor selection context.
- Add `Rename Session` and `Export Session to HTML` commands, the latter
  offering to open the exported file.
- Add a status bar entry showing the runtime phase and active model.
- Add the `piAgentSidebar.autoRetry` setting (default on) to retry transient
  provider errors such as overloads, rate limits, 5xx, and interrupted streams.
- Render file edit diffs in the tool timeline with added, removed, and context
  lines.
- Turn `path/to/file.ts:42` references in responses into links that open the
  file at that line.
- Activate on startup so the sidebar restores without opening it first.

## 0.2.13

- Add `author`, `repository`, `homepage`, and `bugs` metadata to the package
  manifest and link the source repository from the README.

## 0.2.12

- Color inline code references blue and switch toolbar, tool, and reasoning
  hover backgrounds to a neutral gray.
- Keep the running send button a solid accent that brightens on hover.
- Even out composer, message, and reasoning spacing and reliably scroll to the
  latest message after sending, including image replies.

## 0.2.11

- Give the composer host-owned attachment IDs with bounded, regular-file image
  reads, magic-byte validation, immediate temporary-file cleanup, and
  per-extension-host storage isolation.
- Serialize new/switch/delete session mutations and resolve a relative
  `piAgentSidebar.sessionDirectory` against the workspace folder.
- Bind pi extension UI responses to the originating runtime so a restart cannot
  answer the replacement process.
- Give every inline code reference a unique marker plus a tracked composer span
  so same-line selections and literal text no longer collide.
- Validate webview messages and pi RPC snapshots at the boundary and harden the
  webview CSP and nonce.
- Add hermetic attachment, protocol, composer, RPC, and async-queue tests plus
  a reproducible-build drift check; stop committing generated bundles.

## 0.2.10

- Add a product screenshot to the Marketplace overview.
- Add `Cmd+Esc` (`Ctrl+Esc` on Windows and Linux) editor-selection references
  with exact unsaved text, accent-colored inline `@path#line` markers, and
  source navigation.

## 0.2.9

- Replace the session history panel with a compact searchable popover and add
  confirmed deletion with active-session and workspace safety checks.
- Add a sharper transparent 256 px Marketplace icon.
- Place active LSP/runtime status and context usage on one compact composer row,
  hiding inactive states and preserving truncated details in tooltips.
- Replace the visible working label and spinner with a reduced-motion-aware
  accent light that sweeps across the composer divider.
- Keep current reasoning expanded while it streams, collapse it automatically
  when the message completes, and tighten consecutive activity spacing.
- Reserve enough composer width for short thinking levels such as `xhigh` and
  expose the complete selected value in a tooltip.

## 0.2.0

- Redesign the Webview around a restrained terracotta visual system inspired
  by the information density of Claude Code while retaining Pi branding.
- Add full-width user turns and a unified reasoning/tool activity timeline
  with polished command output panels and persistent disclosure state.
- Rework the composer with an orange border and focus ring, stable narrow-width
  controls, orange primary action, compact metadata, and clearer busy state.
- Improve dark, light, high-contrast, reduced-motion, and narrow sidebar styles.
- Strip ANSI styling sequences from extension status and widget text.
- Preserve the reader's scroll position while the agent is working.

## 0.1.12

- Use a compact 8 px Webview gutter and remove the header settings button,
  leaving only session history and new session actions.

## 0.1.11

- Remove the Webview document padding so header actions can align with the
  actual right edge while content areas retain their own spacing.

## 0.1.10

- Move the visible agent run state from the session header to the bottom of the
  active response, replacing the standalone streaming cursor.

## 0.1.9

- Align the session action buttons closer to the view's right edge.

## 0.1.8

- Show reasoning content directly beside its label instead of collapsing it.
- Add a visible working indicator, animated header progress line, pulsing status
  dot, and accessible busy state while the agent runs.

## 0.1.7

- Merge the Send and Stop controls into one stateful composer button.

## 0.1.6

- Remove hidden connection-banner layout space and hide the welcome state as
  soon as the first prompt is submitted.

## 0.1.5

- Size the model and thinking selectors to their selected text instead of
  stretching them across the composer toolbar.

## 0.1.4

- Finalize concurrent storage and cleanup for pasted clipboard images.

## 0.1.3

- Let the model and thinking selectors use available width and wrap on narrow
  sidebars instead of truncating their values.
- Support pasting PNG, JPEG, GIF, and WebP clipboard images directly into the
  prompt editor, with host-side count and size validation.

## 0.1.2

- Remove the New Session, Restart Runtime, and Show Logs buttons from the view
  title bar. The commands remain available from the Command Palette.

## 0.1.1

- Namespace commands, views, configuration, and workspace state so Pi Agent
  Sidebar can coexist with other pi extensions.
- Harden Webview reconnection, session switching, RPC framing, runtime shutdown,
  image limits, accessibility, and narrow-view behavior.
- Add RPC framing and custom session-directory regression tests.

## 0.1.0

- Add the Pi Agent WebviewView in VS Code's auxiliary sidebar.
- Add pi RPC process management, streaming messages, tool states, and native
  extension UI requests.
- Add session history, restoration, model and thinking controls, attachments,
  Workspace Trust, and VSIX packaging.
