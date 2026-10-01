# AI Bridge

Connect web AI chats (**DeepSeek, ChatGPT, Gemini, Claude, Mistral, Qwen, Kimi**) — or a local **Ollama** model — directly to VS Code. AI Bridge drives a dedicated, hidden Chrome instance, lets the AI read and edit your workspace through an approval-based tool loop, and shows everything in a chat sidebar.

## Features

- 💬 **Chat sidebar** with provider switcher (Auto / DeepSeek / ChatGPT / Gemini / Claude / Mistral (Vibe) / Qwen / Kimi / Ollama local)
- 🔀 **Auto fallback** — try the last web provider through Chrome; if it fails, continue on local Ollama automatically
- 🟢 **Status badge** — live 🟢🟡🔴 indicator for Chrome/Ollama next to the provider picker (click for a report)
- 🤖 **Agentic loop** — the AI calls tools step by step: read, write, edit, search, run commands, git
- 🔌 **MCP client** — connect any external [Model Context Protocol](https://modelcontextprotocol.io/) server (`.vscode/mcp.json` or `aiBridge.mcpServers`); its tools are discovered automatically and exposed to the AI as `mcp_<server>_<tool>`, with the same approval flow as built-in tools
- 🔍 **Native diff review** — file writes open a real VS Code diff (old vs. new content) with **Accept / Reject** buttons **inline in the chat** (reliable fallback) and in the VS Code notification — whichever you click first decides — plus a per-file "don't ask again" option; the file is only touched after you accept
- 🧪 **Auto-verify & auto-repair** — after every file write the project is checked automatically (`astro check` / `tsc --noEmit` / `build`); the full error goes back to the AI for repair (max 3 attempts) and, if it still fails, the changes are **rolled back automatically** to the last verified state
- 🔄 **Git checkpoints & one-click restore** — before every prompt the project is snapshotted with a temporary git commit (`aibridge-prompt:<id>`); each user message gets a 🔄 button in the chat that brings the project back to that exact state (`git reset --hard`, with an automatic backup commit of the current state first). Folders that aren't git repos yet are initialized automatically (`git init` + a minimal `.gitignore`; `aiBridge.autoInitGit`), and a one-time chat notice explains it when git itself is unavailable; toggle with `aiBridge.promptCheckpoints`
- 🔊 **Text-to-speech** — every AI reply has a 🔊 button (next to Copy) that reads it aloud (Web Speech API; Romanian voice when installed), split into sentence-sized chunks for long answers; click again to stop
- 🎤 **Voice input (local Whisper, offline)** — the 🎤 button captures audio **in the Extension Host** (the VS Code webview sandbox has no microphone access, so recording runs in the extension's own process — no SoX, nothing to install: on Windows a native C# `winmm` recorder driven by PowerShell; on macOS/Linux, SoX via `node-audiorecorder` when available) and transcribes it with **whisper.cpp on your machine** (no cloud, no Google services): click to record (live timer + pulsing button), click again to stop — the text is appended to the message box; Romanian + English via `aiBridge.sttLanguage`; the one-time `AI Bridge: Setup Local Whisper` command downloads the engine + `ggml-base` model (~160 MB) into global storage
- 🔎 **Verbose mode (diagnostic transparency)** — a 🔍 toolbar toggle (persisted across sessions) that shows every AI step in the chat as collapsible cards: **🧠 Thinking** (the model's reasoning — DeepSeek-R1 / Claude extended thinking / Gemini / Ollama `message.thinking`), **⚙️ Executing** (tool + exact command/target), **📄 Result** (tool output, capped at 4 000 chars) and **🔀 Decision** (tool choice, auto-retry, auto-repair, rollback). Off by default = only the final answers, exactly as before.
- ✅ **Approval cards** for commands/git; optional ⚡ auto-approve (with an explicit warning)
- 📎 **Attachments** — files, folders, images & binaries (text is embedded, binaries are uploaded to the web chat)
- 🧠 **Auto-context** — project structure, language, package manager and frameworks are sent with every message
- 🛠️ **Self-healing selectors** — when a provider changes its UI, AI Bridge repairs its CSS selectors automatically
- 🧑 **Human-like input & anti-detect** — messages are typed with human timing (random delays, punctuation pauses, bursts), a MutationObserver detects the exact moment generation finishes (no fixed polling), and small mouse moves/scrolls precede clicks; each feature can be toggled (`aiBridge.humanTyping`, `aiBridge.mutationObserver`, `aiBridge.humanBehavior`)
- ☁️ **Remote selector fixes** — publish repaired selectors to a public GitHub Gist (`aiBridge.selectorsUrl`); every client picks them up without an extension update (bundled selectors stay as fallback)
- 🧠 **AI-powered selector discovery** — when the classic healer fails on a redesigned site, a cleaned DOM snapshot goes to the local Ollama model; the proposed selectors are validated in the live page, applied immediately and saved to `selectors-user.json` (global storage)
- 🦙 **Ollama mode** — fully local, no browser required
- 🌙 **Hidden Chrome** — runs offscreen with its own profile, never steals focus; it automatically comes on screen when a provider asks for login (and hides again after you sign in), or bring it back anytime with 👁 Show Chrome

## Requirements

- VS Code 1.90+
- Google Chrome or Microsoft Edge installed (auto-detected; override with `aiBridge.chromePath`)
- A logged-in session for each web provider (first time only — log in inside the AI Bridge Chrome profile)

## Getting started

1. Install the extension, open the **AI Bridge** view in the activity bar.
2. Pick a provider. On first use a hidden Chrome launches with a dedicated profile stored in VS Code's global storage (not in your project).
3. Log into the provider once — if a login page is detected, AI Bridge brings Chrome on screen, waits for you to sign in, then hides the window again and continues automatically.
4. Type a message. File writes open a native diff in the editor (Accept / Reject from the in-chat card or the VS Code notification); command approvals appear as cards in the chat. Or enable ⚡ auto-approve at your own risk.

## Commands

| Command | What it does |
| --- | --- |
| `AI Bridge: Open Browser` | Launch / connect the dedicated Chrome |
| `AI Bridge: Close Browser` | Really close it (graceful CDP close + PID fallback) |
| `AI Bridge: Show Chrome` | Move the offscreen Chrome window back on screen and focus it |
| `AI Bridge: Show Provider Status` | Detailed report: CDP port, DeepSeek login, Ollama models |
| `AI Bridge: Clear No-Ask File List` | Forget the files you marked "Accept (don't ask again)" |
| `AI Bridge: Reset Repaired Selectors` | Forget auto-repaired selectors, go back to `selectors.json` |
| `AI Bridge: Update Selectors` | Fetch and apply the selector config from the configured Gist |
| `AI Bridge: Diagnostics` | Environment check: browser, CDP port, profile, Ollama, selectors, MCP |
| `AI Bridge: MCP Servers` | Manage MCP servers: status, restart/stop, list tools, open/create `.vscode/mcp.json` |
| `AI Bridge: Setup Local Whisper` | Download the prebuilt whisper.cpp binaries + `ggml-base` model into global storage (one time, ~160 MB) for offline voice input |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `aiBridge.provider` | `deepseek` | Active provider (`auto` = browser provider → Ollama fallback) |
| `aiBridge.ollamaModel` | `qwen2.5-coder:7b` | Model used in local mode |
| `aiBridge.ollamaUrl` | `http://localhost:11434` | Ollama server URL |
| `aiBridge.cdpPort` | `9222` | CDP port used to launch / connect Chrome |
| `aiBridge.chromePath` | *(empty)* | Manual Chrome/Edge path (empty = auto-detect) |
| `aiBridge.messageTimeoutMinutes` | `20` | Total time budget for one agentic message |
| `aiBridge.autoVerify` | `true` | Check the project after every file write (`astro check` / `tsc --noEmit` / `build`); failures trigger up to 3 AI repair attempts, then an automatic rollback to the last verified state |
| `aiBridge.promptCheckpoints` | `true` | Create a git checkpoint before every prompt and show the 🔄 restore button on each user message |
| `aiBridge.autoInitGit` | `true` | Run `git init` (plus a minimal `.gitignore`, if missing) when the project folder isn't a git repo yet, so checkpoints / 🔄 restore work out of the box |
| `aiBridge.selectorsUrl` | *(empty)* | Raw URL of a public Gist with `selectors.json` (`version` + `providers`); empty = remote selectors disabled |
| `aiBridge.checkSelectorsOnStartup` | `true` | Look for a newer selector config at startup — at most once every 24 h (only when `aiBridge.selectorsUrl` is set) |
| `aiBridge.humanTyping` | `true` | Type messages with human timing (random delays, punctuation pauses, bursts); off = instant insertion |
| `aiBridge.humanBehavior` | `true` | Small mouse moves before clicks + occasional gentle scroll (anti-detect) |
| `aiBridge.mutationObserver` | `false` | Experimental: end-of-generation detection via MutationObserver (fast, low CPU). Can be flaky when Chrome runs offscreen — JS is suspended in invisible windows; default off = reliable 500 ms polling |
| `aiBridge.sttLanguage` | `ro-RO` | Language for the 🎤 voice input (local Whisper) — `ro-RO` (Romanian) or `en-US` (English); applied at the next transcription |
| `aiBridge.whisperCliPath` | *(empty)* | Path to `whisper-cli` (whisper.cpp) for offline voice input; empty = auto-detect (global storage → classic whisper.cpp locations → PATH) |
| `aiBridge.whisperModelPath` | *(empty)* | Path to the Whisper ggml model (e.g. `ggml-base.bin`); empty = auto-detect |
| `aiBridge.whisperTimeoutSeconds` | `180` | Timeout for one Whisper transcription (10–1200 s) |
| `aiBridge.aiSelectorFinder` | `true` | AI selector-discovery fallback: when the classic healer finds nothing, a cleaned DOM snapshot is analyzed by local Ollama; validated selectors are saved to `selectors-user.json` |
| `aiBridge.aiFinderTimeoutSeconds` | `45` | Timeout (5–300 s) for the AI selector analysis |
| `aiBridge.mcpEnabled` | `true` | Start the configured MCP servers and expose their tools to the AI (`mcp_<server>_<tool>`) |
| `aiBridge.mcpServers` | `{}` | MCP servers to launch (stdio), e.g. `{"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}` |
| `aiBridge.mcpToolTimeoutSeconds` | `60` | Timeout for a single MCP tool call (`tools/call`) |

## Remote selector updates

Selector repairs can reach every client without shipping a new extension version:

1. Keep the same JSON shape as `src/selectors.json` and **bump `version`** (`updated` / `changelog` are optional but recommended).
2. Save it as a file named `selectors.json` in a **public GitHub Gist**.
3. Set `aiBridge.selectorsUrl` to the Gist **raw** URL, e.g. `https://gist.githubusercontent.com/<user>/<id>/raw/selectors.json`.

AI Bridge then checks on startup — rate-limited to once every 24 h — and on demand via `AI Bridge: Update Selectors`, applying the config only when its `version` is newer than the active one. The update is validated, merged over the bundled config, cached locally, and local auto-repairs for the slots it touches are replaced by the curated fix. Any failure (invalid JSON, HTTP error, timeout) leaves the current config in place.

## MCP servers

AI Bridge ships a **Model Context Protocol** client: MCP servers give the agent extra tools (databases, browsers, APIs, file systems, …) beyond the built-in ones. Configure them once — they are launched with VS Code and their tools are exposed to the AI as `mcp_<server>_<tool>`.

1. Add servers to `.vscode/mcp.json` (or to the `aiBridge.mcpServers` setting):

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

2. Servers start with VS Code (`aiBridge.mcpEnabled`, default on) and config edits are hot-reloaded. Use **`AI Bridge: MCP Servers`** to check status, restart/stop a server, or list its tools.

Every MCP call shows an **approval card** (server, tool and arguments) before it runs — ⚡ auto-approve skips it like any other tool. Only the **stdio** transport is supported. A crashed or missing server is reported in the chat and in `AI Bridge: Diagnostics`.

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
code --install-extension ai-bridge-1.7.2.vsix --force
```

Press <kbd>F5</kbd> for an Extension Development Host.
