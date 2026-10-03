# Changelog

## 0.9.2

- Stay attached through scroll events the reader did not cause. A layout
  change that shrank the transcript — the composer collapsing after a send, an
  image settling for its fallback — pulled the pinned offset back, and the
  bare scroll event reporting it read as an upward gesture: the view detached
  and stayed detached for the rest of the reply. A scroll landing on the
  bottom edge is now the browser holding a pinned viewport in place, not a
  hand on the wheel; a send re-pins through a render of its own rather than
  waiting for the next one; a view returning from hidden or resized while
  attached re-pins over the drift it never saw; a fresh build — a session
  switch or a just-opened view — pins to the newest message outright and
  keeps pinning outright through the settling that follows, the backfill,
  the image loads, the composer finding its height, until the reader takes
  over; and a native nudge during a send's eased climb retargets it instead
  of ending it.

- When the reader has scrolled away from the newest messages, a circular chip
  floats in the transcript's lower corner and asks, with one click, to be
  taken back: it follows the bottom again and eases there the same way a send
  does. It hides itself while attached, within reach of the bottom edge, or
  before the reader could mistake it for part of the conversation — it is
  chrome, and it never reflows the text it hovers over.

## 0.9.1

- Spend the transcript's frames on the content, not the bookkeeping. An
  expanded tool call streaming output swaps just its body now — a chunk used
  to re-parse and rebuild the whole message, which read as stutter while a
  chatty command ran. The running border breathes through overlays whose
  opacity animates, so parallel running calls cost compositor layer updates
  instead of a repaint per card per frame. And a fresh build of a long
  transcript stages its newest messages first, backfilling the history above
  the fold a window at a time, so switching sessions lands on the newest
  message in the first frame instead of a blank beat.

## 0.9.0

- Let a running call say so on the box itself: the border breathes between a
  faint and the full-strength pending edge while a halo swells and fades around
  it, and stops the frame the call settles — the border drops from the breath's
  own full strength straight to the settled green, with nothing entering or
  leaving the header line. The header now carries no status glyph at all, only
  the `output` column it always ends in: the column is the same width in every
  box, the header text ellipsises into the space it leaves, so the clip lands at
  the same offset in every box instead of wherever that box's path happened to
  end, and a call with nothing to reveal keeps the column empty rather than
  absent. The spinner used to sit in that column and hand its width back to the
  text the frame it left, sliding the `output` hint toward the edge and moving
  the ellipsis with it, exactly where the reader was watching the command run.
  Both ends of the breath derive from the palette's pending border, which is
  also the box's static running edge — the key frames merely overshoot it — so
  `prefers-reduced-motion` can drop the animation and the edge still reads as
  pending, and forced-colours mode, which overrides tint and halo both,
  carries the state in a dashed edge instead.

- Keep an answer where pi put it when the next message arrives while the answer
  is still being revealed. A follow-up prompt is handed to pi the moment the run
  that produced the answer stops, which is while the tail of that answer is still
  animating in: the prompt was spliced above the reply it follows, and the reply
  then settled underneath it. The reader saw the question jump over the answer,
  and the turn reshuffle once more when pi's own order arrived. The reply now
  records the place it belongs at from its first frame, and both the live row and
  the row it settles into are put back there. A steering message sent mid-run
  takes the same path.

- Stop trusting a state refresh — a rename, a model change, a reconnect — to
  carry the answer pi is streaming. It never does: pi holds that reply outside
  the message list until it ends, so the newest assistant message a snapshot
  lists is a finished one. The view resumed that older answer in the streaming
  reply's place and appended every later delta to its text. A snapshot now hands
  the reply the view is already revealing over to pi's copy once pi has one,
  keeps it on screen while it is still arriving, and lets a view that reloaded
  mid-reply show the text a delta carries at once instead of waiting for the end.

## 0.8.3

- Draw a run of reasoning parts as one section. GPT reports reasoning as a
  series of summary parts and pi hands each part over as its own `thinking`
  block, so a single answer opened a stack of collapsed "Thinking" rows — most
  of them three or four lines of headline — and reading the reasoning meant
  opening every part of it in turn. Adjacent parts now share one section, joined
  by a blank line and streamed as one block, so one click opens the whole run.
  Only a part that prose or a tool call separates from the next keeps its own
  section: the visible blocks between them are what keep the activity timeline
  in order, and the merge never crosses one.

- Fold a collapsed tool box or skill card onto one line, whatever it holds. A
  long shell command or path wrapped to three lines in a 380px sidebar, so a run
  of calls buried the prose that explains them — the thing collapsing a settled
  call exists to prevent. The collapsed line now ellipsises instead of wrapping,
  and the `output` hint, the `N lines` count and the running spinner keep their
  place at the end of that line rather than being clipped along with the text.
  Every collapsed box clips, running or settled: a call is drawn before its
  output exists, so a clip that waited for a body let a long command arrive
  wrapped to three lines and snap to one mid-run, which read as a flicker right
  where the reader was watching. A box with nothing to open has no click that
  would bring the clipped part back, so the full text rides in `title` alongside
  the DOM text that selection, copy and assistive tech read; expanding restores
  the wrapping line unchanged.

## 0.8.2

- Fold "Duplicate this session" and "Fork from an earlier prompt" into one
  overflow menu behind an ellipsis trigger in the header. Both derive a new
  session from this one and neither is a frequent move, so neither earns a
  permanent slot in a header whose pixels belong to the session title; when the
  pi build offers neither action, the trigger removes itself rather than opening
  onto nothing. The menu opens downwards — the side with room, given an anchor at
  the top of the sidebar — and it takes focus on open, so the arrow keys and
  Home/End work without reaching for the mouse first. Escape closes it onto the
  trigger, and the fork picker an item opens hands focus back the same way: not
  to the item that opened it, which by then went with the menu.
- Give a tool box one surface whatever its state. A running call and a settled one
  are the same green, and only a failure recolours the box: a call that arrived in
  one tint and turned green the moment it settled flickered, and a round of calls
  settling in sequence read as a glitch rather than as progress. "Still running"
  was always the spinner's and the visually-hidden status text's to carry, which
  is why the state stays available to assistive tech without colour. The
  custom-message and skill cards keep the pending tint, now its only consumer.

## 0.8.1

- Stop sending a long session's whole history in every snapshot. `get_messages`
  has no pagination, so a session that had grown to thousands of messages sent
  megabytes the webview cannot show — it renders the newest 150 and reports the
  rest as omitted — and re-sent all of it on every turn. A snapshot now carries
  the newest 600, which leaves roughly twice the render cap once the tool results
  that never get a node are filtered out, and the count the reader sees ("N
  earlier messages omitted") now adds up the host's window and the webview's own
  cap instead of reporting only the cap's share. Below that size nothing about
  the transcript changes.
- Keep a session's title after its first prompt scrolls out of the window. With
  no session name of its own, the title falls back to the session's first user
  message, and once that message was outside the window the sidebar renamed the
  session after whatever prompt happened to be oldest on screen. The host reads
  the first user message off the list it still holds and sends its text along for
  the title alone — not as a transcript entry — so the webview shapes it through
  the same pi-context strip and truncation it applies to a message it can see,
  and reaches for its own window only when the host could not offer one.
- Recover a submit whose `actionResult` never arrives. The webview clears its
  in-flight state there, so a reply the editor refused to deliver to a hidden
  view left Enter dead and the send button disabled until the sidebar was
  reloaded. The host now keeps the replies a hidden view refused — `actionResult`,
  plus the image answers the webview never asks for twice — and replays them on
  reveal, and the webview separately unlatches a submit that a snapshot itself
  proves was accepted. That proof needs the timestamp as well as the text: the
  newest user message has to be this prompt and be stamped at or after the
  submit, because a sentence the reader asked twice earlier in the session would
  otherwise mark a refused retry as accepted — and a false positive here clears
  the composer, losing a prompt pi never received.
- Report a refused command as a notice instead of a fatal error. Anything thrown
  while handling a message that carries no `actionId` — a `mailto:` link, a
  transcript path outside the workspace, a workspace folder that has gone away —
  travelled on `connection: error`, which marks the in-flight reply aborted,
  disables sending, and leaves Restart as the banner's only button. Those now
  arrive as a transient toast, and the webview refuses a non-HTTP link before the
  round trip so a stray click on `[doc](README.md)` cannot cost the session in
  the first place. `ready` still owns the fatal banner, because a failed start is
  about pi itself.
- Stop the process tree pi started, not just pi. pi runs the bash tool by
  spawning a shell, and a signal sent to pi alone left those children running
  after a restart or a reload — with their stdin closed, so they were also
  invisible. pi is now spawned in its own process group and the group is
  signalled, which is the only handle on a descendant whose parent has already
  exited; Windows has no group to signal and keeps signalling the direct child.
- Stop rebuilding the transcript after every turn. A snapshot re-parses every
  message, so object identity — which the incremental renderer's signatures are
  built on — was lost for the whole transcript at once: every rendered message
  was rebuilt, its markdown parsed, sanitized and highlighted again, and the node
  swapped. A rebuilt node drops what it carried, so thinking blocks and tool
  cards the reader had opened closed themselves. Identities are now carried
  across the snapshot for the tail that can still be on screen, paired by exact
  content rather than by position — a snapshot can insert or drop entries, so
  pairing by index would hand one message another's slot, and an identity adopted
  for content that actually changed would leave a stale node on screen, which is
  worse than the rebuild it avoids.
- Open the paths pi prints, including the ones that start with a dot.
  `.vscode/settings.json` and `.github/workflows/ci.yml` lost their leading dot
  to a `\b` that treats it as a word boundary, and the host's own normalization
  stripped every leading `.` and `/` for the same reason — so the two most common
  configuration paths in pi's output could not be opened. The pattern now uses a
  lookbehind, and the host removes only an explicit `./`: a traversal hidden in
  the middle (`src/../../../etc/passwd`) is still rejected, while `src/a..b.ts`
  still opens, because `..` inside a segment is part of a file name.
- Leave the reader's editor alone when a preset asks pi about the file. "Explain
  this file" and the other selection-shaped commands had no selection to
  reference when the file was merely open, so they wrote a whole-document
  selection into the editor — the user's file came out selected and their cursor
  moved — to hand the reference builder a range. The range is now passed to the
  reference and the editor is never touched.
- Do less work per render pass. The transcript re-renders on every streaming
  frame, and each pass did things it could not use: it rebuilt the attachment
  chips (stranding keyboard focus on `body` and replacing every button under the
  pointer), re-measured the composer tools row's fold, read the textarea's
  metrics before writing styles that invalidate them, and re-scanned a draft of
  up to 200K characters to recompute highlight ranges that had not changed.
  `Intl` formatters are built once per locale instead of per visible timestamp,
  and the workspace's recursive file watcher — one `**/*` watcher per window —
  starts with the first `@` search rather than with the view, since nothing can
  invalidate a cache that does not exist yet.
- Close the CSS surface in the transcript's sanitizer, and escape an attached
  image's payload. DOMPurify's html profile allows `<style>` and `style=`, and the
  webview's CSP has to keep `'unsafe-inline'` for styles because mermaid's SVG
  carries its own — so text that reached the transcript could repaint the
  composer, the connection banner, or a dialog. Both call sites now share one
  policy that forbids both, with `script-src` already nonce-only. The base64
  payload of an image block is escaped like its mime type rather than trusted for
  being base64.
- Ask the compiler to prove both dispatch points are exhaustive. The host's and
  the webview's switches over the message unions each ended in a bare `break`, so
  a variant added to either union compiled cleanly and then vanished at runtime;
  a `default` arm that takes `never` turns that into a build failure.
  `WEBVIEW_REQUEST_TYPES` lists every request the webview can send, the compiler
  refuses to build if the union and the list disagree, and a unit test walks the
  list to prove the parser accepts one of each.
- Run the release command in CI, and the suite on Windows. Two jobs are new:
  `verify-windows`, because the Windows launch path, the non-POSIX branch of the
  process-tree kill, and every path separator a composer reference carries had no
  execution record anywhere; and `package`, which runs `npm run package` — the
  same command a release runs — so the `files` allowlist, the entry point and the
  production build are checked on every push rather than on release day.

## 0.8.0

- Outline tool boxes and custom-message cards with a 1px border in a mid-tone of
  their own colour — the same mid-tone in both palettes, mixed at 55% over the
  light page and used at full strength over the dark one. A translucent fill says
  "something is here" but not where it stops, and at 85% a light-theme box was
  near-opaque anyway, so the border now carries the state: 5–6:1 against the dark
  sidebar, 1.7:1 against the light page, where the fills sit at ~1.2:1 and
  ~1.07:1. The dark palette does not thin its edges the way the light one does:
  half a mid-tone over a dark backdrop measures ~2.4:1, a line adrift in the
  colour it was mixed from. Each palette's fill keeps its own idea of a quiet
  wash, which is why the fills stay on pi's saturated hues while the borders do
  not — chroma is what survives dilution, and a hairline in emerald or brick red
  beside grey prose is louder than the box it delimits, however thin it gets. The
  inset drops by the border's 1px so a box's text stays on the same column as the
  prose around it, and the three tool states keep one border width so nothing
  shifts when a call settles.
- Border skill invocations and extension messages in the custom-message family's
  own colour, at the same per-palette strength, so the two cards read as one kind
  of thing — neither the model's prose nor a tool's output — with the `[skill]`
  label left to say which of the two it is. They keep an edge in forced-colours
  mode too, where the translucent colour is what gets dropped first.

## 0.7.12

- Draw `mermaid` code fences as diagrams. A fence stayed a code block, so a
  conversation that explains a flow in mermaid had to be read as arrows and
  `<br/>` tags. The picture now replaces the source once it is ready, and the
  source stays one click away in a disclosure underneath it: a diagram is drawn
  at its own scale, so the text is still the accessible, searchable, and copyable
  form of the same content, and the copy button the block already carried keeps
  working. Diagrams keep the width their author drew them at and the frame
  scrolls, because scaling a 900px flowchart into the sidebar's column renders its
  labels unreadably small.
- Load mermaid only when a diagram appears. The library is 3.3MB of JavaScript,
  and a diagram is rare in a coding conversation, so it ships as a second webview
  bundle that the first diagram pulls in; a session that never shows one never
  fetches or parses it. Nothing about the cost is paid up front — the main webview
  bundle grew by 6KB, which is this change's own code.
- Theme diagrams from the editor palette, and leave a diagram that cannot be drawn
  as source with an explanation. Colours are read from the theme's variables and
  handed to mermaid's `base` theme, and a value mermaid's colour library cannot
  parse — a computed `color-mix()`, or a variable the theme does not define —
  falls back instead of failing the whole diagram. A fence mermaid rejects keeps
  its text and gains a one-line reason above it, so the reader still has what they
  need to fix it.
- Give the diagram types that draw categories the theme's chart colours. mermaid
  derives its series palette from the same two colours it fills nodes with, and
  those are surfaces — picked to sit next to the transcript, not against it — so a
  pie slice or a timeline band could come out the colour of the background it was
  drawn on. `charts.blue` and its five siblings are what VS Code publishes for
  this, and the labels that go on a slice or a band are now picked against that
  colour rather than against the transcript: light on the blue, dark on the
  yellow, whichever reads better on each.
- Render a diagram when it is about to be looked at, not when its message mounts.
  Long conversations hold several diagrams and each one costs a layout pass, so
  the render waits until the block is near the viewport and diagrams are drawn one
  at a time. `style-src` in the webview CSP now allows inline styles, which is
  what a mermaid SVG brings with it (its own `<style>` element and inline style
  attributes); `script-src` is unchanged, and the SVG is inserted with everything
  executable removed from it.

## 0.7.11

- Show images a transcript names by path. A Markdown image pointing at a file
  rendered as a broken picture, and nothing said why: only the host can turn a
  path into a URI the webview is allowed to load (`asWebviewUri`), a relative
  path in the webview resolves against the webview's own origin rather than the
  file system, and a `file:` URL is stripped by the sanitizer on the way in —
  silently, because what survives is still a valid `<img>` with no source. The
  renderer now writes the path into `data-media-source`, the webview asks for
  every path it has no answer for, in batches of up to 20, and the host replies
  with a URI it built. Only images inside a workspace folder or the temp directory
  are readable — a relative path is resolved against pi's working directory first,
  and every path is canonicalized
  before it is checked, so a symlink cannot walk out of those roots. Anything
  refused — a path outside them, a non-image file, a picture over 24 MB, a remote
  URL, which the webview CSP would block anyway — is replaced by its alt text
  rather than left as a broken image or a silent gap.
- Enlarge a transcript picture by clicking it. The cap that keeps one screenshot
  from taking over the sidebar also shrinks a tall one past reading, so a click
  now opens the picture over the transcript at panel size. That overlay reuses
  the modals' backdrop, which already owns Escape, an outside click, and focus
  restore, instead of growing a second one; the dialog itself paints no panel, so
  the picture is what the reader sees. The pointer, a tooltip, and Enter on the
  focused picture all name the same gesture, because a picture — unlike a button —
  carries no affordance of its own, and a click that ends a drag-select is
  ignored: that one is the reader copying text.
- Declare the workspace folders and the temp directory in `localResourceRoots`.
  `asWebviewUri` hands back a URI for any file, but the editor only serves files
  under a declared root, so a transcript image would have failed to load even
  once it resolved. The temp directory is in that list deliberately: tool output
  and rendered previews land there, which is the trade this feature is built on.

## 0.7.10

- Update the session usage chip and its panel while a reply is still streaming.
  pi's `message_update` events carry the running usage of the call in flight, so
  the footer's context percentage (and, in the panel, the token breakdown and
  cost) now move during the reply instead of waiting for `agent_settled` and the
  next `get_session_stats` snapshot. Finished calls accumulate onto the last
  authoritative snapshot, and that snapshot still wins the moment it lands, so
  the running numbers never drift from pi's own accounting. Context reads the
  most recent call rather than the running total, calls pi would skip (aborted or
  errored) are skipped here too, and the post-compaction "unavailable until the
  next response" reading now fills in as soon as the next stream reports usage.
  Providers that only report usage once a response completes still update at the
  end of each call rather than only after the whole run settles.

## 0.7.9

- Keep reasoning collapsed while it streams and after it settles, instead of
  auto-expanding during the reply and auto-collapsing the moment it ends. The
  thinking block is now its own control in both states: expanding it shows the
  live reasoning (streamed incrementally) or the settled body, and collapsing it
  again stops that per-frame work entirely. A collapsed block carries no body,
  so a long reasoning wall no longer pays a full parse at the settle frame —
  the stutter that appeared right as the thinking block shrank away.

## 0.7.8

- Close the gap that appeared between a thinking block and the tool box that
  follows it. pi sends a text block before tool calls even when the model
  produced only whitespace there, so the placeholder rendered as an empty
  `.assistant-text` whose top padding plus the full prose-to-tool line below it
  pushed the timeline apart; empty sections now hold no vertical space (and the
  blank frame before streaming settles is covered too).

## 0.7.7

- Keep assistant and reasoning output moving continuously through tool events and
  long replies, while incrementally forming live Markdown without repeatedly
  reparsing completed content or running code highlighting before settlement.
- Preserve reader ownership during wheel, touch, scrollbar, and inertial
  scrolling, then resume the existing smooth bottom follow only after native
  scrolling settles. Existing Thinking spacing remains unchanged.
- Keep explicit multi-line sends attached through the independent user-message
  echo and composer resize phases, without pulling the viewport back after the
  reader deliberately scrolls away.

## 0.7.6

- Smoothly follow streaming transcript growth instead of jumping on every delta,
  while respecting the user's reduced-motion preference and immediately yielding
  when they scroll toward older messages.
- Make bottom reattachment resilient to inertial scrolling without mistaking
  delayed programmatic scroll events or browser overflow anchoring for reader
  intent, preventing the transcript from pulling an upward-scrolling reader back
  to the latest message.

## 0.7.5

- Keep the pinned prompt compact without changing the source message. Its font,
  line height, and text column still align with the original user turn, while a
  tighter vertical inset makes the persistent navigation surface consume less
  reading space. The bottom divider, shadow, and expansion control remain.

## 0.7.4

- Render pi's `/skill:name` invocations the way its TUI does. The SKILL.md
  payload collapses into a `[skill] name` card — markdown body rendered on
  demand, expansion state preserved across transcript rebuilds — and the
  arguments typed after the command stay a separate user bubble, instead of
  the whole block dumping into the user message as raw markdown source.
- Unify extension custom messages and skill cards on the tool-box surface
  tint. The dark palette's custom-message fill was a dark slab measuring ~1:1
  against the sidebar, invisible under bright light — the same failure an
  earlier fix solved for tool boxes. Both surfaces now inherit that fix.

## 0.7.3

- Fix session history coming up empty on Windows. The sidebar encodes the
  workspace path into pi's per-project session directory name
  (`~/.pi/agent/sessions/--<encoded-cwd>--`), but collapsed separator runs
  where pi replaces each one, so the Windows drive prefix `C:\` produced
  `--C-Users-...--` where pi writes `--C--Users-...--`. The encoding now
  matches pi's `getDefaultSessionDirPath` character for character, so existing
  Windows sessions are found without the `piAgentSidebar.sessionDirectory`
  workaround. POSIX-encoded names are unchanged.

## 0.7.2

- Queue a message as a follow-up with `Alt+Enter`, matching pi's TUI shortcut.
  `Enter` sends as before. The choice is forwarded as pi's public
  `streamingBehavior` field, so a follow-up waits until the current run ends
  instead of interrupting it; pi ignores the field when idle, so the shortcut
  doubles as a plain send. A plain `Enter` keeps the previous behavior and
  steers only when the host knows pi is streaming. Hovering or focusing the send
  button names both shortcuts, since a keyboard-only affordance is otherwise
  invisible.
- Show the steering and follow-up queues separately in the composer status row
  (`2 steering · 1 follow-up`). Which queue a message sits in is the only
  visible difference between the delivery modes, so a single merged count could
  not convey it.
- Stop rendering extension `setStatus` reports in the composer status row. They
  are persistent by nature (pi's LSP extension reports `LSP Active: ...` for the
  whole session), and the row is reserved for queue counts and transient run
  states like compacting and retrying. The host no longer forwards them.
- Make tool boxes legible under bright ambient light. pi's near-black tool
  surfaces sat within ~2 L* of the sidebar backdrop (1.06–1.12:1), invisible in
  a sunlit room — and no dark fill could climb out of that without shouting.
  The dark palette's tool fills are now light tints at pi's hue directions
  (periwinkle, green, rose) mixed at 20%, measuring ~1.4:1 against the sidebar
  while every text inside keeps ≥ 2.8:1. The light palette is unchanged.
- Give the user message box the same treatment: at the old 30% mix it measured
  1.08:1 against the sidebar — nearly as invisible as the tool boxes were. The
  dark palette's message hues gain chroma and mix at 45%, which also firms up
  custom messages and, through the shared knob, hover rows, the scrollbar and
  search matches (still quieter than VS Code's own hover). The light palette is
  unchanged.
- Render session cost as `$0.45` rather than `US$0.45`. Chromium's ICU expands a
  plain USD currency to the wide symbol in en locales; pinning the narrow symbol
  matches what Node already produced.

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
