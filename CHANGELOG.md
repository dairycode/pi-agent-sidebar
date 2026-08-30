# Changelog

## 0.7.1

- Start pi out of the box on Windows. npm installs the global `pi` command as a
  `.cmd` shim, which Node's spawn refuses to run directly, so the sidebar could
  not launch pi with the default configuration. When `pi` fails to probe on
  Windows and `piAgentSidebar.binaryPath` is still the default, the extension
  now falls back to launching node.exe with the global pi install's entry script
  as its first argument: node.exe is located via `where.exe` and the usual
  Program Files locations, and the entry script by reading the installed
  package's `bin` field under npm's APPDATA global root, the node install
  directory, or `npm root -g`. The lookup is cached and re-runs when pi is
  restarted explicitly. A `binaryPath` pointing at anything other than `pi` is
  respected as-is; when the fallback cannot resolve a node executable or a pi
  install, the error names both the original failure and the options (install pi
  globally or set `piAgentSidebar.binaryPath`).

## 0.7.0

- Fix the light theme: surfaces and accent now carry enough chroma to read on a
  near-white sidebar. pi's literal light values were authored for a terminal,
  where dark ink and the user's own backdrop separate the surfaces; at ~3%
  chroma the tool state tints vanished over a white background (pending,
  success and error all landed as one pale grey box) and the 17%-chroma accent
  read as grey where it filled a button. Hue directions and value grades stay
  pi's; the adjustment is documented as the third deliberate departure in
  `pi-theme.css`. The light-theme accent hover darkens instead of fading, and
  state colours (toasts, session delete, fork warning) come from pi's palette
  like the transcript they summarise.
- Session history rows share one right-edge action slot. Rename and delete were
  mutually exclusive (rename needs the active session, delete a non-active
  one) but each kept its own grid column, so a row showing rename reserved an
  empty delete column beside it. Each row now renders exactly one action button.
- Header clone and fork buttons no longer grey out while a turn is running.
  Clicking them mid-turn shows a toast explaining why the action must wait,
  matching rename, history, and new session, which already refused that way.
- The preview devtool applies `vscode-light`/`vscode-dark` to the webview body
  as VS Code does, so `--theme=light` renders the real light palette instead of
  the dark one over light variables, and it gains a `--state=history` preset.

## 0.6.3

- Remove the confirmation dialogs for starting a new session and deleting a
  history session. Neither action needs a guard: pi keeps the current
  conversation in session history when a new session starts, so nothing is
  ever discarded, and deleting a history entry is routine list management.
  Both now take effect immediately; the rename prompt is unchanged.
- Stop the pristine first screen from showing a vertical scrollbar. The empty
  placeholder occupied the full transcript height while the message list below
  it kept its reserved top/bottom padding even with no children, so the empty
  session always carried about 48px of phantom scrollable overflow. The
  placeholder now fills the transcript out of flow and contributes no scroll
  height of its own.

## 0.6.2

- Keep scrolling smooth while a reply streams in. The transcript was rebuilt
  wholesale on every frame — all 150 rendered messages re-parsed from markdown,
  re-sanitized, and every node in the scroll container replaced — so a streaming
  reply spent the frame budget re-rendering history that had not changed, and
  left the browser no stable node to anchor the scroll position to. Messages now
  keep one node each and are rebuilt only when their own content changes, so a
  streaming reply touches a single node per frame.
- Stop short upward scrolls from snapping back to the bottom mid-stream."Follow
  the newest message" was decided purely from distance to the bottom edge, with
  a 96px allowance, so a small upward drag still looked like sitting at the
  bottom and the next delta pulled the reader back down. Upward wheel and touch
  gestures now detach the view immediately, before any scrolling happens, and
  only arriving back at the bottom re-attaches it. Sending a message or switching
  session still jumps to the newest message.
- Measure the pinned turn label in its own frame instead of straight after the
  transcript is written, so reading each prompt's position no longer forces a
  synchronous re-layout of content that was just invalidated.

## 0.6.1

- Share the image size limits and the JSON coercion helpers between the webview
  and the host instead of keeping separate copies. The per-image and per-batch
  ceilings previously lived in two files, so changing one without the other let
  the webview accept a paste the host would then reject.

## 0.6.0

- Pin the prompt whose turn the transcript is scrolled into, so a long reply
  never leaves "what did I ask to get this?" unanswered. Scrolling back through
  history relabels the bar with each earlier prompt and it disappears above the
  first one. The bar collapses to a single line with an expand toggle when the
  prompt overflows, caps its expanded height and scrolls internally instead of
  displacing the transcript, and clicking it jumps to the prompt it names.

## 0.5.2

- Add folders to the composer from Explorer's context menu, by holding `Shift`
  while dragging them into the sidebar, or through the `@` browser. Selecting a
  folder keeps path browsing active; typing whitespace to end the token turns
  the chosen folder into a reference without removing the typed separator. A
  complete manually typed `@path/` follows the same host-confirmed flow. Folder
  references pass only the directory path to pi, do not eagerly read or expand
  its contents, and reveal the folder in Explorer when opened.
- Route passive pi notifications, such as background log-cleanup summaries, to
  the Pi Agent output log instead of VS Code notification popups. Warnings,
  errors, and prompts that require user interaction remain visible.

## 0.5.1

- Highlight complete, valid slash commands such as `/compact` in blue once pi
  recognizes them. Only the command token is highlighted; arguments, incomplete
  names, unknown commands, paths, and slash characters in ordinary prose retain
  the normal composer color.
- Eliminate the visual flash when selecting a file from the `@` workspace
  browser. The final `@path` marker is now highlighted immediately and keeps its
  position while the extension host assigns the reference identity; failed
  registrations safely remove the temporary marker.

## 0.5.0

- Add a level-by-level `@` workspace browser to the composer: each view shows
 only the current directory's immediate files and folders, selecting a folder
 descends into it, and `Enter` or `Tab` inserts the selected file as the same
 inline `@path` reference Explorer and drag-and-drop already produce. VS Code's
 `files.exclude` and `search.exclude` settings apply.
- Preserve the current in-memory contents when **Explain This File** targets an
 unsaved or untitled editor, and reopen submitted references by their canonical
 URI so files in other multi-root workspace folders navigate correctly.
- Add workspace files to the composer as clickable inline `@path` references
 through an Explorer context-menu action or by holding `Shift` and dragging
 from VS Code Explorer. File and selection references share the same composer
 lifecycle and open with `Cmd`/`Ctrl`-click or `F12`.
- Keep the `+` picker distinct from drag-and-drop: picked files and images render
 as removable attachment chips, while dropped files enter the text composer as
 inline references.
- Make the entire Pi sidebar a file drop target and show a compact,
 Codex-inspired full-surface overlay with a subtle accent tint and an
 edge-to-edge, square dashed drop boundary that reuses the sidebar's accent.
- Expose **Pi Agent: Focus Input with Selection** above **Explain Selection**
 in the editor context submenu, reusing the existing inline `@path#line`
 selection flow without inserting a preset instruction.

## 0.4.4

- Add session rename: the session header and the active session's row in the
  history list now offer a rename button that opens an inline prompt. The name
  is applied through pi's public `set_session_name` RPC, so it stays in sync
  with pi's own session listings and survives reloads; non-active sessions are
  not renameable without switching to them first, which the disabled row button
  explains. Renaming refreshes both the header title and the history list.
- Refresh the session list after a command-palette rename so history shows the
  new name immediately, and reject empty names before they reach pi.
- Rewrite the README Features section to cover the current feature set
  (streaming, session management, editor integration, slash commands, tool
  timeline, security model) and drop the Development section.

## 0.4.3

- Fix streaming output: assistant replies now appear live instead of all at
  once after a long wait. pi 0.84+ streams `message_update` events as deltas
  (`assistantMessageEvent` with `text_delta`/`thinking_delta`/`toolcall_delta`
  chunks) rather than cumulative message snapshots, and the strict RPC event
  validator rejected every delta for missing the former `message` field,
  dropping them before the webview could render. The validator now accepts the
  delta shape (legacy snapshots still pass), and the webview assembles the
  partial message from deltas by `contentIndex` — text, reasoning, and tool
  call arguments stream live and are replaced by the authoritative
  `message_end` copy when the message completes.
- Extract the delta assembly into `webview/streaming.ts` with unit tests,
  including a replay check that the assembled content matches pi's
  `message_end` payload exactly.
- Fix the layout jump when a reply starts: pi opens assistant messages with an
  empty `content: []` that is filled by deltas, and rendering that empty shell
  inserted a blank message slot that shoved a bottom-anchored transcript up
  ~20px right as streaming began. The placeholder is skipped until the first
  content block arrives; the busy indicator covers the gap.
- Fix the same jump when pi queues a message while busy: the composer status
  row (`"1 queued"`) appeared and disappeared on demand, resizing the
  transcript. The row now keeps its slot whether or not it has text.
- Fix `npm run preview`, which crashed since 0.4.1: the document template
  calls `asWebviewUri(...).with({ query })` to cache-bust the stylesheet, but
  the preview's vscode stub returned a bare string. The stub now supports
  `.with()`, and the bootstrap waits on timers instead of a double
  `requestAnimationFrame`, which `--dump-dom` with `--virtual-time-budget`
  does not reliably advance (the second frame often never runs).

## 0.4.2

- Render extension custom messages (role `custom`, e.g. remote-pi's QR pair
  code) live as they arrive instead of waiting for the next snapshot: the
  stream reducer previously only accepted `assistant`, `user`, and
  `toolResult` roles, silently dropping the `message_start`/`message_end`
  events pi emits for `sendMessage` calls, so the QR only appeared after
  reloading the view.
- Preserve whitespace in custom messages with `white-space: pre-wrap`: the QR
  block art is plain text lines joined by single newlines, which markdown
  keeps as soft breaks and the browser then collapses into one wrapped line.
- Give the QR half-block art terminal-style metrics (`line-height: 1.2`) so
  it renders square instead of stretched ~28% taller than wide by the body's
  `1.5` line-height.

## 0.4.1

- Fix the welcome logo's corner gaps by rendering the mark as one inline SVG,
  with no separate image border, clipping curve, or shadow. Cache-bust the
  stylesheet whenever the Webview is recreated.

## 0.4.0

- Add a `/` composer button that lists the slash commands pi reports, grouped
  into extensions, prompt templates, and skills, with the scope each was loaded
  from. Typing `/` at the start of a composer line opens the same list and
  filters it as you type, where `ArrowUp`/`ArrowDown` move the selection and
  `Enter`/`Tab` complete. A `/` mid-line or after a space is left alone, so
  prose like `and/or` and paths like `src/main.ts` never trigger it.
- Insert `/name` into the composer rather than submitting it, because commands
  such as `/deploy prod` take arguments. Commands that take none cost one extra
  `Enter` in exchange.
- Re-read `get_commands` each time the list opens: extensions, templates, and
  skills load independently of the session events that refresh the snapshot, so
  the copy held from the last snapshot can be stale. The panel renders that copy
  first and replaces it on response, so it never flashes empty.
- Drop individual command entries that arrive without a usable name instead of
  failing the whole response, and pass through command sources this extension
  does not recognize. A kind pi adds later loses its grouping header rather than
  its rows.
- Built-in interactive commands such as `/model` and `/compact` are absent by
  design: pi excludes them from `get_commands` because they are handled only in
  its TUI and would not execute if sent as a prompt. The sidebar already exposes
  the common ones as buttons. Argument completion is also unavailable, since
  `getArgumentCompletions` is not part of the RPC payload.
- Stop the model and thinking pickers jumping 4px narrower partway through a
  drag. A `max-width: 320px` media query trimmed their padding to claw back room,
  which fired at a breakpoint unrelated to whether the labels actually fit. Narrow
  widths are handled by dropping labels instead, which is measured. Removing a
  `max-width: 100%` from the same rule fixed a second squeeze: a hard cap
  overrides `flex-shrink: 0`, and a clamped button stops overflowing its
  container, which is the very signal the label/icon switch measures.
- Give every composer-toolbar control one height, one corner radius, and a faint
  resting border, so the row reads as a set rather than loose glyphs. The border
  is scoped to the composer; the session header's buttons sit 1px apart, where a
  border on each would double into a thick seam.
- Show the pickers' labels or their icons, never both, and never a truncated
  label. Dropping the redundant icon also frees the width that used to force the
  icon-only state sooner. Below icon-only both pickers hide entirely: a sidebar
  can be narrower than five controls, and hiding beats slicing an icon in half.
- Align the status row and attachment list to the composer's text edge. They are
  siblings of `.composer`, so they inherited none of its inset and hung 8-12px
  past the send button.
- Draw the slash trigger as an inline SVG. The codicon set has no plain slash, and
  a text character is positioned by its font's ascent and descent, so it could
  never share an optical centre with the codicons beside it. The path is fitted to
  measured codicon metrics: 12.06px ink height, and a 1.3 stroke against a 1.13px
  stem because a diagonal of equal width reads lighter.
- Add `npm run preview`, which renders the webview in headless Chrome for visual
  checks. It uses the real `createWebviewDocument()` and `media/main.css` so the
  preview cannot drift from what ships, stubs only what VS Code owns, and fails
  loudly if the injected theme is blocked — a silently unstyled shot still looks
  plausible while every measurement in it is wrong.

## 0.3.3

- Replace the native model and thinking `<select>` elements with themed popups.
  A native dropdown's list is drawn by the operating system, so it could not
  follow the VS Code theme or this view's styling. The replacements reuse the
  session history panel's surface, border, and shadow, mark the current value
  with a checkmark, and support `ArrowUp`/`ArrowDown`, `Home`/`End`,
  `Enter`/`Space`, `Escape`, outside clicks, and `role="listbox"` semantics.
- Show the composer pickers' labels in full or not at all. Both collapse to
  icons together once the row no longer fits, measured from script because label
  widths range from `Max` to `Claude Sonnet 4.5 (latest)` and no fixed media
  query threshold suits every model. Previously the model name was the only
  element that gave way, so it was ellipsised and then clipped out of sight
  entirely while the thinking level held a fixed 108px.
- Keep the popup from skewing in a narrow sidebar: its `min-width` floor now
  yields to the available width instead of fighting `max-width`.

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
