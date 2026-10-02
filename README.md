# Freekit

Connect web AI chats (**DeepSeek, ChatGPT, Gemini, Claude, Mistral, Qwen, Kimi**) — or a local **Ollama** model — directly to VS Code. Freekit drives a dedicated, hidden Chrome instance, lets the AI read and edit your workspace through an approval-based tool loop, and shows everything in a chat sidebar.

## Features

- 💬 **Chat sidebar** with provider switcher (Auto / DeepSeek / ChatGPT / Gemini / Claude / Mistral (Vibe) / Qwen / Kimi / Ollama local)
- 🔀 **Auto fallback** — try the last web provider through Chrome; if it fails, continue on local Ollama automatically
- 🟢 **Status badge** — live 🟢🟡🔴 indicator for Chrome/Ollama next to the provider picker (click for a report)
- 🤖 **Agentic loop** — the AI calls tools step by step: read, write, edit, search, run commands, git
- 🖥️ **Dev servers in a visible terminal** — `dev` / `start` / `serve` / `watch` / `preview` commands (`npm run dev`, `npm start`, `vite`, `nodemon`, …) are detected automatically and start in a dedicated **VS Code terminal** (`Freekit: dev`): you watch the live output in the bottom panel and stop the server with **Ctrl+C** in that terminal; the AI gets the live URL and the first seconds of output immediately (captured via the stable Shell Integration API) instead of waiting for a command that never exits — fast startup errors (port already in use, syntax errors) still come back for self-correction. Stop everything with `Freekit: Stop Dev Servers` (Ctrl+C to every server terminal)
- 🔌 **MCP client** — connect any external [Model Context Protocol](https://modelcontextprotocol.io/) server (`.vscode/mcp.json` or `freekit.mcpServers`); its tools are discovered automatically and exposed to the AI as `mcp_<server>_<tool>`, with the same approval flow as built-in tools
- 🧭 **Semantic code search (local index)** — index the workspace once and the AI can find code by **meaning**, not just exact text: `Freekit: Index Workspace` embeds every chunk with a local Ollama embedding model (`nomic-embed-text`, 768-dim) and stores it as a plain JSON vector store in globalStorage (**zero new npm dependencies**, nothing leaves your machine). The AI gets a `search_semantic(query)` tool (e.g. *"where do we validate the login token?"*) that returns the best-matching snippets with file paths, line ranges and scores; `Freekit: Index Status` shows what's indexed and `Freekit: Clear Index` wipes it. Indexing is **incremental** (only changed files are re-embedded, matched by content hash) and can also run **on save** (`freekit.semanticIndex.onSave`). Smart exclusions keep it fast: `node_modules`, `.git`, `out`, `dist`, `build`, caches, lockfiles, minified files and binaries are skipped, files over `freekit.semanticIndex.maxFileKb` are ignored, and large files are split into overlapping chunks
- 🔍 **Native diff review** — file writes open a real VS Code diff (old vs. new content) with **Accept / Reject** buttons **inline in the chat** (reliable fallback) and in the VS Code notification — whichever you click first decides — plus a per-file "don't ask again" option; the file is only touched after you accept
- 🧪 **Auto-verify & auto-repair** — after every file write the project is checked automatically (`astro check` / `tsc --noEmit` / `build`); the full error goes back to the AI for repair (max 3 attempts) and, if it still fails, the changes are **rolled back automatically** to the last verified state
- ⟲ **Git checkpoints & one-click restore** — before every prompt the project is snapshotted with a temporary git commit (`freekit-prompt:<id>`); each user message gets a ⟲ button in the chat that brings the project back to that exact state (`git reset --hard`, with an automatic backup commit of the current state first). Folders that aren't git repos yet are initialized automatically (`git init` + a minimal `.gitignore`; `freekit.autoInitGit`), and a one-time chat notice explains it when git itself is unavailable; toggle with `freekit.promptCheckpoints`
- 🗂 **Conversations, edit & fork** — every chat is a persisted conversation: the dropdown above the chat switches between them (➕ new, 🗑 delete; titles come from the first prompt; the old single history migrates automatically). Hover any of your messages for three actions: **✐ edit** (rewind the git checkpoint, drop everything after that message and re-send the edited prompt), **ᛉ fork** (branch a new conversation from that message — the original stays in the list) and **⟲ restore**
- 🔊 **Text-to-speech** — every AI reply has a 🔊 button (next to Copy) that reads it aloud (Web Speech API; Romanian voice when installed), split into sentence-sized chunks for long answers; click again to stop
- 🎤 **Voice input (local Whisper, offline)** — the 🎤 button captures audio **in the Extension Host** (the VS Code webview sandbox has no microphone access, so recording runs in the extension's own process — no SoX, nothing to install: on Windows a native C# `winmm` recorder driven by PowerShell; on macOS/Linux, SoX via `node-audiorecorder` when available) and transcribes it with **whisper.cpp on your machine** (no cloud, no Google services): click to record (live timer + pulsing button), click again to stop — the text is appended to the message box; Romanian + English via `freekit.sttLanguage`; the one-time `Freekit: Setup Local Whisper` command downloads the engine + `ggml-base` model (~160 MB) into global storage
- 🔎 **Verbose mode (diagnostic transparency)** — a 🔍 toolbar toggle (persisted across sessions) that shows every AI step in the chat as collapsible cards: **🧠 Thinking** (the model's reasoning — DeepSeek-R1 / Claude extended thinking / Gemini / Ollama `message.thinking`) shown live while the model reasons, then collapsed Cline-style with a ▼/▶ arrow and the total duration (e.g. *🧠 Thinking (2.3s)*); click the header to expand it again, **⚙️ Executing** (tool + exact command/target), **📄 Result** (tool output, capped at 4 000 chars) and **🔀 Decision** (tool choice, auto-retry, auto-repair, rollback). Off by default = only the final answers, exactly as before.
- ✅ **Approval cards** for commands/git; optional ⚡ auto-approve (with an explicit warning)
- 📎 **Attachments** — files, folders, images & binaries (text is embedded, binaries are uploaded to the web chat)
- 🧠 **Auto-context** — project structure, language, package manager and frameworks are sent with every message
- 🛠️ **Self-healing selectors** — when a provider changes its UI, Freekit repairs its CSS selectors automatically
- 🧑 **Human-like input & anti-detect** — messages are typed with human timing (random delays, punctuation pauses, bursts), a MutationObserver detects the exact moment generation finishes (no fixed polling), and small mouse moves/scrolls precede clicks; each feature can be toggled (`freekit.humanTyping`, `freekit.mutationObserver`, `freekit.humanBehavior`)
- 🍪 **Consent popups closed automatically** — cookie banners and terms/OK dialogs are accepted for you (safe exact-match on 3 confidence tiers; “Reject / Only necessary / Customize” are never clicked); scans include iframes and run after page loads, before New Chat and right before typing — toggle with `freekit.autoAcceptPopups`
- ☁️ **Remote selector fixes** — publish repaired selectors to a public GitHub Gist (`freekit.selectorsUrl`); every client picks them up without an extension update (bundled selectors stay as fallback)
- 🧠 **AI-powered selector discovery** — when the classic healer fails on a redesigned site, a cleaned DOM snapshot goes to the local Ollama model; the proposed selectors are validated in the live page, applied immediately and saved to `selectors-user.json` (global storage)
- 🦙 **Ollama mode** — fully local, no browser required
- 🌙 **Hidden Chrome** — runs completely in the background (minimized; on Windows with **no taskbar button** and absent from Alt+Tab), never steals focus; it automatically comes on screen when a provider asks for **login or a CAPTCHA** (and hides again when you're done), or bring it back anytime with 👁 Show Chrome

## Requirements

- VS Code 1.90+
- Google Chrome or Microsoft Edge installed (auto-detected; override with `freekit.chromePath`)
- A logged-in session for each web provider (first time only — log in inside the Freekit Chrome profile)

## Getting started

1. Install the extension, open the **Freekit** view in the activity bar.
2. Pick a provider. On first use a hidden Chrome launches with a dedicated profile stored in VS Code's global storage (not in your project).
3. Log into the provider once — if a login page is detected, Freekit brings Chrome on screen, waits for you to sign in, then hides the window again and continues automatically. CAPTCHA challenges (reCAPTCHA / hCaptcha / Cloudflare “Just a moment”) get the same treatment.
4. Type a message. File writes open a native diff in the editor (Accept / Reject from the in-chat card or the VS Code notification); command approvals appear as cards in the chat. Or enable ⚡ auto-approve at your own risk.

## Commands

| Command | What it does |
| --- | --- |
| `Freekit: Open Browser` | Launch / connect the dedicated Chrome |
| `Freekit: Close Browser` | Really close it (graceful CDP close + PID fallback) |
| `Freekit: Show Chrome` | Bring the hidden Chrome window back on screen and focus it |
| `Freekit: Show Provider Status` | Detailed report: CDP port, DeepSeek login, Ollama models |
| `Freekit: Clear No-Ask File List` | Forget the files you marked "Accept (don't ask again)" |
| `Freekit: Reset Repaired Selectors` | Forget auto-repaired selectors, go back to `selectors.json` |
| `Freekit: Update Selectors` | Fetch and apply the selector config from the configured Gist |
| `Freekit: Diagnostics` | Environment check: browser, CDP port, profile, Ollama, selectors, MCP |
| `Freekit: MCP Servers` | Manage MCP servers: status, restart/stop, list tools, open/create `.vscode/mcp.json` |
| `Freekit: Setup Local Whisper` | Download the prebuilt whisper.cpp binaries + `ggml-base` model into global storage (one time, ~160 MB) for offline voice input |
| `Freekit: Stop Dev Servers` | Stop every dev server started by the AI (sends Ctrl+C to its terminal; if the process ignores it, the terminal is closed) |
| `Freekit: Index Workspace` | Build / update the local semantic index (embeddings via Ollama, incremental, cancellable, with progress) |
| `Freekit: Index Status` | Show the index: model, dimensions, indexed files, chunks, storage file, size and last update |
| `Freekit: Clear Index` | Delete the workspace's semantic index from globalStorage (confirmation required) |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `freekit.provider` | `deepseek` | Active provider (`auto` = browser provider → Ollama fallback) |
| `freekit.ollamaModel` | `qwen2.5-coder:7b` | Model used in local mode |
| `freekit.ollamaUrl` | `http://localhost:11434` | Ollama server URL |
| `freekit.cdpPort` | `9222` | CDP port used to launch / connect Chrome |
| `freekit.chromePath` | *(empty)* | Manual Chrome/Edge path (empty = auto-detect) |
| `freekit.messageTimeoutMinutes` | `20` | Total time budget for one agentic message |
| `freekit.autoVerify` | `true` | Check the project after every file write (`astro check` / `tsc --noEmit` / `build`); failures trigger up to 3 AI repair attempts, then an automatic rollback to the last verified state |
| `freekit.promptCheckpoints` | `true` | Create a git checkpoint before every prompt and show the ⟲ restore button on each user message |
| `freekit.autoInitGit` | `true` | Run `git init` (plus a minimal `.gitignore`, if missing) when the project folder isn't a git repo yet, so checkpoints / ⟲ restore work out of the box |
| `freekit.selectorsUrl` | *(empty)* | Raw URL of a public Gist with `selectors.json` (`version` + `providers`); empty = remote selectors disabled |
| `freekit.checkSelectorsOnStartup` | `true` | Look for a newer selector config at startup — at most once every 24 h (only when `freekit.selectorsUrl` is set) |
| `freekit.humanTyping` | `true` | Type messages with human timing (random delays, punctuation pauses, bursts); off = instant insertion |
| `freekit.humanBehavior` | `true` | Small mouse moves before clicks + occasional gentle scroll (anti-detect) |
| `freekit.mutationObserver` | `false` | Experimental: end-of-generation detection via MutationObserver (fast, low CPU). Can be flaky when Chrome runs offscreen — JS is suspended in invisible windows; default off = reliable 500 ms polling |
| `freekit.autoAcceptPopups` | `true` | Automatically accept consent popups (cookie / terms / “OK” / “Got it”). Safe exact-match on three confidence tiers; refusal wording (Reject / Only necessary / Customize / Not now) is never clicked; max 3 clicks per pass |
| `freekit.sttLanguage` | `ro-RO` | Language for the 🎤 voice input (local Whisper) — `ro-RO` (Romanian) or `en-US` (English); applied at the next transcription |
| `freekit.whisperCliPath` | *(empty)* | Path to `whisper-cli` (whisper.cpp) for offline voice input; empty = auto-detect (global storage → classic whisper.cpp locations → PATH) |
| `freekit.whisperModelPath` | *(empty)* | Path to the Whisper ggml model (e.g. `ggml-base.bin`); empty = auto-detect |
| `freekit.whisperTimeoutSeconds` | `180` | Timeout for one Whisper transcription (10–1200 s) |
| `freekit.aiSelectorFinder` | `true` | AI selector-discovery fallback: when the classic healer finds nothing, a cleaned DOM snapshot is analyzed by local Ollama; validated selectors are saved to `selectors-user.json` |
| `freekit.aiFinderTimeoutSeconds` | `45` | Timeout (5–300 s) for the AI selector analysis |
| `freekit.mcpEnabled` | `true` | Start the configured MCP servers and expose their tools to the AI (`mcp_<server>_<tool>`) |
| `freekit.mcpServers` | `{}` | MCP servers to launch (stdio), e.g. `{"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}` |
| `freekit.mcpToolTimeoutSeconds` | `60` | Timeout for a single MCP tool call (`tools/call`) |
| `freekit.semanticIndex.enabled` | `true` | Enable semantic code search (`search_semantic` tool + index commands) |
| `freekit.semanticIndex.model` | `nomic-embed-text` | Ollama embedding model for the index (changing it invalidates the index) |
| `freekit.semanticIndex.onSave` | `false` | Re-index a file automatically (incremental, debounced) when it is saved |
| `freekit.semanticIndex.maxFileKb` | `256` | Skip files larger than this (KB) when indexing |
| `freekit.semanticIndex.topK` | `8` | Number of chunks returned by `search_semantic` (1–25) |
| `freekit.semanticIndex.exclude` | `[]` | Extra directory/file names to exclude from indexing |

## Semantic code search

Freekit can find code **by meaning** instead of exact text — useful for questions like *"where do we retry a failed upload?"* when you don't know the identifier to grep for.

1. Run **`Freekit: Index Workspace`** once (needs Ollama running; the embedding model is pulled with `ollama pull nomic-embed-text`).
2. Ask the AI something conceptual. It calls `search_semantic(query)` and gets back the best-matching chunks with `path:startLine-endLine`, a similarity score and a snippet — then it can `read_file` the ones that matter.

How it works:

- **Local & private** — embeddings are computed by your own Ollama server (`freekit.ollamaUrl`); the vector store is a single JSON file under `<globalStorage>/semantic-index/` (keyed per workspace). No new npm dependencies, no cloud.
- **Incremental** — each file is fingerprinted with a SHA-1 of its content; unchanged files keep their existing vectors, so re-indexing after an edit only re-embeds what changed. Set `freekit.semanticIndex.onSave` to keep the index fresh automatically (debounced 1.5 s).
- **Smart exclusions** — `node_modules`, `.git`, `out`, `dist`, `build`, `.next`, `coverage`, virtualenvs, `target`, caches, lockfiles, source maps, minified and binary files are never indexed; extend the list with `freekit.semanticIndex.exclude`.
- **Chunking with overlap** — files are split into 60-line windows with a 12-line overlap so a function that straddles a boundary is still found; oversized/minified files are skipped and recorded in the status.
- **Graceful in the agent loop** — if there is no index yet, `search_semantic` returns a clear message telling the AI to fall back to `search_files` (or you to run the index command), so nothing breaks.

## Remote selector updates

Selector repairs can reach every client without shipping a new extension version:

1. Keep the same JSON shape as `src/selectors.json` and **bump `version`** (`updated` / `changelog` are optional but recommended).
2. Save it as a file named `selectors.json` in a **public GitHub Gist**.
3. Set `freekit.selectorsUrl` to the Gist **raw** URL, e.g. `https://gist.githubusercontent.com/<user>/<id>/raw/selectors.json`.

Freekit then checks on startup — rate-limited to once every 24 h — and on demand via `Freekit: Update Selectors`, applying the config only when its `version` is newer than the active one. The update is validated, merged over the bundled config, cached locally, and local auto-repairs for the slots it touches are replaced by the curated fix. Any failure (invalid JSON, HTTP error, timeout) leaves the current config in place.

## MCP servers

Freekit ships a **Model Context Protocol** client: MCP servers give the agent extra tools (databases, browsers, APIs, file systems, …) beyond the built-in ones. Configure them once — they are launched with VS Code and their tools are exposed to the AI as `mcp_<server>_<tool>`.

1. Add servers to `.vscode/mcp.json` (or to the `freekit.mcpServers` setting):

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

2. Servers start with VS Code (`freekit.mcpEnabled`, default on) and config edits are hot-reloaded. Use **`Freekit: MCP Servers`** to check status, restart/stop a server, or list its tools.

Every MCP call shows an **approval card** (server, tool and arguments) before it runs — ⚡ auto-approve skips it like any other tool. Only the **stdio** transport is supported. A crashed or missing server is reported in the chat and in `Freekit: Diagnostics`.

## Safety

- Writes open a **native VS Code diff** for review — decide via the **Accept / Reject buttons in the chat** or from the VS Code notification; shell commands and git operations require approval via chat cards unless auto-approve is enabled.
- The extension refuses to run in **untrusted workspaces**.
- Anti-spam limits: max 3 writes per file and 15 write operations per message.
- The webview runs with a strict Content Security Policy.

## Development

```bash
npm install
npm run compile        # tsc → out/
npx @vscode/vsce package --allow-missing-repository
code --install-extension freekit-2.0.0.vsix --force
```

Press <kbd>F5</kbd> for an Extension Development Host.
