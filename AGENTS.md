# AGENTS guide

Guidance for AI agents and contributors working on this repository.

## What this project is

This is a VS Code extension that embeds the [pi](https://pi.dev) coding agent in
the auxiliary sidebar. pi itself is a highly capable, extensible agent. This
extension is a **thin client** around it, not a competing agent.

## Design principles

The extension exists to do exactly two things. Any change should serve one of
them:

1. **A friendlier sidebar UI.** Render pi's conversation, tools, and state in a
   theme-aware Webview, and provide convenient entry points (commands, menus,
   status bar) for interacting with pi.
2. **VS Code project context.** Feed pi the context that only VS Code has and pi
   cannot obtain on its own — editor selections, LSP diagnostics, document
   symbols, and similar workspace signals.

The core agent capability stays with pi. The extension must **not** reimplement
or alter what pi already does. If a change starts duplicating pi's behavior,
that is a signal the feature is wrong.

### The litmus test

> If a feature's correctness depends on *how pi is implemented internally*, it
> is a bad feature. If it depends only on *what VS Code provides* and *pi's
> public RPC protocol*, it is a good feature.

Concretely:

- **Good:** consuming pi's public RPC (`set_session_name`, `export_html`,
  `set_auto_retry`, the `result.details.diff` a tool returns) and rendering it.
- **Good:** injecting VS Code-only context (diagnostics, document symbols,
  selections) into the prompt via the `<pi-context>` block.
- **Bad:** recomputing something pi already produces (e.g. diffing file edits
  ourselves), or depending on the private argument shape of a specific tool.
  These break silently when pi changes and duplicate pi's job.

When in doubt, prefer transparently forwarding pi's own output over recreating
it in the client.
