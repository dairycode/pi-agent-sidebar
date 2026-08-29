import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export function createWebviewDocument(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = randomBytes(24).toString("base64url");
  const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewRoot, "main.js"),
  );
  const styleUri = webview
    .asWebviewUri(vscode.Uri.joinPath(webviewRoot, "main.css"))
    .with({ query: `v=${nonce}` });
  const codiconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewRoot, "codicons", "codicon.css"),
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codiconUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Pi Agent</title>
</head>
<body>
  <div id="resource-drop-overlay" class="resource-drop-overlay" aria-hidden="true" hidden>
    <div class="resource-drop-prompt">
      <span>Drop to add context</span>
    </div>
  </div>

  <div id="app">
    <header id="session-header" class="session-header">
      <div class="session-title-wrap">
        <span id="connection-dot" class="connection-dot" role="status" aria-label="Pi is starting"></span>
        <div id="session-title" class="session-title" title="Untitled">Untitled</div>
      </div>
      <div class="header-actions" role="toolbar" aria-label="Session actions">
        <button id="rename-session-button" class="icon-button" type="button" title="Rename session" aria-label="Rename session"><i class="codicon codicon-edit"></i></button>
        <button id="history-button" class="icon-button" type="button" title="Session history" aria-label="Session history" aria-controls="history-panel" aria-expanded="false"><i class="codicon codicon-history"></i></button>
        <button id="new-session-button" class="icon-button" type="button" title="New session" aria-label="New session"><i class="codicon codicon-add"></i></button>
        <button id="clone-session-button" class="icon-button" type="button" title="Duplicate this session" aria-label="Duplicate this session"><i class="codicon codicon-files"></i></button>
        <button id="fork-session-button" class="icon-button" type="button" title="Fork from an earlier prompt" aria-label="Fork from an earlier prompt" aria-haspopup="listbox" aria-controls="fork-panel" aria-expanded="false"><i class="codicon codicon-git-branch"></i></button>
      </div>
    </header>

    <main id="transcript" class="transcript" role="log" aria-label="Conversation" aria-live="off">
      <div id="connection-banner" class="connection-banner" hidden></div>
      <div id="pinned-prompt-slot" class="pinned-prompt-slot">
        <div id="pinned-prompt" class="pinned-prompt" hidden>
          <button id="pinned-prompt-body" class="pinned-prompt-body" type="button" title="Scroll to this message" aria-label="Scroll to this message">
            <span id="pinned-prompt-text" class="pinned-prompt-text"></span>
          </button>
          <button id="pinned-prompt-toggle" class="pinned-prompt-toggle icon-button" type="button" hidden aria-expanded="false" aria-controls="pinned-prompt-text" title="Expand this message" aria-label="Expand this message"><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
        </div>
      </div>
      <section id="empty-state" class="empty-state">
        <svg class="empty-logo" viewBox="0 0 256 256" width="54" height="54" aria-hidden="true">
          <rect class="empty-logo-plate" width="256" height="256" rx="48"/>
          <path class="empty-logo-glyph" d="M48 64h160v32h-24v112h-32V96h-48v112H72V96H48V64Z"/>
          <path class="empty-logo-mark" d="M104 112h48v32h-48z" opacity=".9"/>
        </svg>
        <div class="empty-wordmark">pi agent</div>
        <p id="empty-detail" class="empty-detail">Starting in this workspace...</p>
      </section>
      <div id="messages" class="messages"></div>
    </main>

    <aside id="history-panel" class="history-panel" role="region" aria-label="Session history" hidden>
      <div class="history-search" role="search">
        <i class="codicon codicon-search" aria-hidden="true"></i>
        <input id="session-search" type="search" placeholder="Search sessions..." aria-label="Search sessions" autocomplete="off" spellcheck="false">
      </div>
      <div id="session-list" class="session-list" aria-live="polite"></div>
    </aside>

    <aside id="fork-panel" class="history-panel fork-panel" role="region" aria-label="Fork from an earlier prompt" hidden>
      <p class="fork-hint">Pick a prompt to branch from. This session stays in history.</p>
      <div class="history-search" role="search">
        <i class="codicon codicon-search" aria-hidden="true"></i>
        <input id="fork-search" type="search" placeholder="Search prompts..." aria-label="Search prompts" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="fork-list">
      </div>
      <div id="fork-list" class="session-list fork-list" role="listbox" aria-label="Prompts to fork from" aria-live="polite"></div>
      <p id="fork-draft-warning" class="fork-draft-warning" hidden><i class="codicon codicon-warning" aria-hidden="true"></i>Forking replaces what you have typed.</p>
    </aside>

    <div id="widget-area" class="widget-area" hidden></div>

    <footer id="composer-shell" class="composer-shell">
      <div id="composer-status-row" class="composer-status-row" hidden>
        <div id="queue-status" class="queue-status" hidden></div>
        <button id="runtime-meta" class="runtime-meta" type="button" hidden aria-haspopup="dialog" aria-expanded="false" aria-controls="usage-panel" title="Session usage details"></button>
      </div>
      <div id="attachment-list" class="attachment-list" aria-label="Attachments"></div>
      <form id="composer" class="composer">
        <label class="sr-only" for="prompt-input">Message pi</label>
        <span id="prompt-input-help" class="sr-only">File and selection references begin with an at sign. Type an at sign to search workspace files, then use the arrow keys and Enter to add one. Move the caret inside a reference and press F12 to open its source. Hold Shift to drag files from VS Code Explorer into this input.</span>
        <div id="prompt-editor" class="prompt-editor">
          <div class="prompt-highlight-backdrop" aria-hidden="true"><div id="prompt-highlights" class="prompt-highlights"></div></div>
          <textarea id="prompt-input" rows="1" placeholder="Ask pi to build, fix, or explain..." aria-label="Message pi" aria-describedby="prompt-input-help"></textarea>
        </div>
        <div class="composer-toolbar">
          <div id="composer-tools" class="composer-tools">
            <button id="attach-button" class="icon-button" type="button" title="Attach files or images" aria-label="Attach files or images"><i class="codicon codicon-add"></i></button>
            <button id="command-button" class="icon-button" type="button" title="Slash commands" aria-label="Slash commands" aria-haspopup="listbox" aria-controls="command-panel" aria-expanded="false"><svg class="slash-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2.59L5 13.35" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
            <button id="model-select" class="select-control model-control" type="button" title="Model" aria-label="Model" aria-haspopup="listbox" aria-expanded="false" aria-controls="select-popup">
              <i class="codicon codicon-symbol-method" aria-hidden="true"></i>
              <span id="model-select-value" class="select-value"></span>
            </button>
            <button id="thinking-select" class="select-control thinking-control" type="button" title="Thinking level" aria-label="Thinking level" aria-haspopup="listbox" aria-expanded="false" aria-controls="select-popup">
              <i class="codicon codicon-lightbulb" aria-hidden="true"></i>
              <span id="thinking-select-value" class="select-value"></span>
            </button>
          </div>
          <div class="composer-actions">
            <button id="send-button" class="send-button" type="submit" title="Send" aria-label="Send message"><i class="codicon codicon-arrow-up"></i></button>
          </div>
        </div>
      </form>
    </footer>

    <div id="toast-region" class="toast-region" role="status" aria-live="polite"></div>
    <div id="live-status" class="sr-only" role="status" aria-live="polite"></div>
    <div id="select-popup" class="select-popup" role="listbox" hidden></div>
    <div id="command-panel" class="command-panel" role="region" aria-label="Slash commands" hidden>
      <div id="command-list" class="command-list" role="listbox" aria-label="Slash commands"></div>
      <div class="command-search" role="search">
        <svg class="slash-icon is-search" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2.59L5 13.35" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        <input id="command-search" type="search" placeholder="Search commands..." aria-label="Search commands" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="command-list">
      </div>
    </div>
    <div id="mention-panel" class="command-panel mention-panel" role="region" aria-label="Workspace files" hidden>
      <div id="mention-list" class="command-list mention-list" role="listbox" aria-label="Workspace files"></div>
    </div>
    <div id="usage-panel" class="usage-panel" role="dialog" aria-label="Session usage" hidden></div>
    <div id="modal-backdrop" class="modal-backdrop" hidden></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
