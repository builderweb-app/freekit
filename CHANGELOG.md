# Changelog

## 1.10.3 — 2026-10-02

- **Collapsible 🧠 *Thinking* card (Cline-style)** — the reasoning card now stays **expanded with the live text while the model is thinking**, then **collapses on its own** as soon as the visible answer (or an action) starts streaming. A ▼/▶ arrow in the header shows the state and clicking the header toggles the card **manually** at any time, so you can re-read the full reasoning whenever you want.
- **Thinking duration** — the header now reads **🧠 Thinking (2.3s)** once the reasoning is done, accumulating the total time the model spent thinking across the whole prompt (each reasoning segment adds up, measured down to a tenth of a second).

## 1.10.2 — 2026-10-02

- **Thinking text no longer repeated in the 🧠 card** — web providers read “the last reasoning block on the page” at every step of the agentic loop, and the block from the previous step stays mounted, so the very same reasoning was reported (and appended) once more and the collapsed 🧠 *Thinking* card showed it twice (and once more for every extra step). Each block is now displayed only once, and if a block has grown between reads only the new part is appended.

## 1.10.1 — 2026-10-02

- **Restore checkpoint also rewinds the conversation** — ⟲ *restore* used to reset the files with `git reset --hard` but left the transcript untouched, so the chat still showed the prompts and replies that belonged to the discarded state. It now truncates the active conversation right after the restored prompt (the same `truncateAfter` used by *edit prompt*), then refreshes the conversation dropdown and re-renders the chat. The `checkpoint_restored` message is still sent last, so the ✓ badge on the message behaves exactly as before.

## 1.10.0 — 2026-10-02

- **Semantic code search (`search_semantic`)** — the AI can now find code by **meaning** instead of exact text: ask *"where do we validate the login token?"* and it gets the closest snippets back, each with `path:startLine-endLine`, a cosine-similarity score and the code itself. The tool is exposed to every provider through the same one-line-JSON tool-call format (and added to the local-model prompt, `SYSTEM_PROMPT_LOCAL`), is read-only (no approval card), and degrades gracefully: when there is no index yet it tells the model to fall back to `search_files`. The `SYSTEM_PROMPT` tool list already advertised `search_semantic` — it is now actually implemented.
- **Local, private, zero-dependency index** — embeddings are computed by your own Ollama server (`aiBridge.ollamaUrl`) with `nomic-embed-text` (768-dim) via a new `src/indexer/` module, and the vector store is a **single JSON file in globalStorage** (`<globalStorage>/semantic-index/<workspace>-<hash>.json`) — no new npm dependencies, no cloud, nothing leaves the machine. Writes are atomic (temp + rename) and the index is cached in memory (invalidated by mtime) so repeated searches don't re-parse the JSON.
- **Three commands** — `AI Bridge: Index Workspace` (incremental, cancellable, with live per-file progress in the notification and the outcome mirrored into the chat), `AI Bridge: Index Status` (model, dimensions, indexed/skipped files, chunk count, storage path + size, timestamps, on-save state) and `AI Bridge: Clear Index` (modal confirmation, deletes just this workspace's vector store).
- **Incremental indexing** — every file is fingerprinted with a SHA-1 of its content; unchanged files keep their existing vectors, so re-indexing after an edit only re-embeds what actually changed. Optionally keep the index fresh **on save** (`aiBridge.semanticIndex.onSave`, debounced 1.5 s) — off by default, and a no-op when the workspace was never indexed.
- **Smart exclusions & chunking** — `node_modules`, `.git`, `out`, `dist`, `build`, `.next`, `.astro`, `coverage`, virtualenvs, `target`, caches, lockfiles, source maps, minified files and binaries are skipped (extendable via `aiBridge.semanticIndex.exclude`), files above `aiBridge.semanticIndex.maxFileKb` (256 KB) are ignored, and text is split into 60-line chunks with a 12-line **overlap** so a function straddling a boundary is still found. Changing the embedding model invalidates the old index automatically.
- New settings: `aiBridge.semanticIndex.enabled` (default `true`), `.model` (`nomic-embed-text`), `.onSave` (`false`), `.maxFileKb` (`256`), `.topK` (`8`) and `.exclude` (`[]`), plus the three commands in the command palette and the chat view title bar.

## 1.9.2 — 2026-10-02

- **Monochrome SVG icons (Claude design)** — every button in the chat now uses a hand-drawn monochrome SVG instead of an emoji: **attach file** / **attach folder** / **microphone**, **send**, **verbose mode**, **show Chrome**, **clear**, **new conversation**, **delete conversation**, and the per-message actions **edit prompt**, **fork**, **restore checkpoint**, **copy** and **read aloud** (plus the stop state shown while dictating or while a reply is being read out). All of them inherit the theme colour through `fill="currentColor"` — white on dark themes, black on light ones — so no icon ever looks out of place, and no colour is hard-coded. The icons live in a single `ICONS` map in `media/chat.js` and are injected into the toolbar/input buttons on start-up, so there is one source of truth and the webview HTML no longer carries emoji or duplicated inline SVG.
- **Uniform icon sizing** — 16 px for the toolbars and the input area, 14 px for the buttons attached to messages, instead of the previous mix of glyph sizes.
- **Cleaner tooltips** — the labels that still referenced the old emoji (for example the `‹⟲›` hint on *Edit prompt*) now read as plain English, and the microphone placeholder no longer mixes emoji into the recording/transcribing text.

## 1.9.0 — 2026-10-01

- **Multiple conversations** — every chat is now a persisted conversation (global storage): a conversation bar above the chat lists them all in a dropdown (switch back and forth anytime — the transcript and its checkpoints come back exactly as they were), with **➕ new conversation** and **🗑 delete** (native confirmation). Titles come from the first prompt and the dropdown shows each conversation's last activity time; up to 50 conversations are kept. The old single chat history is migrated automatically into one conversation on first start — nothing is lost. **Clear** now empties the active conversation (which stays in the list); switching/editing/forking is politely blocked while a reply is running.
- **Edit prompt (✐)** — hover any of your messages: an ✐ button appears. Click it and the bubble turns into an editable textarea (**💾 Save & resend** / **✕ Cancel**; Ctrl+Enter saves, Esc cancels). Saving rewinds the project to the git checkpoint taken right before that prompt (with the usual automatic backup commit of the current state), drops the edited message and everything after it from the conversation, and **re-sends your edited text** — the fast fix for a prompt that went the wrong way, without retyping the thread. If the message has no checkpoint (not a git repo), the history is still truncated and re-sent, with a chat notice.
- **Fork (ᛉ)** — the same hover row carries a ᛉ button: it branches a **new conversation** from that message (every message up to and including it is copied; titled `[Fork] …` with the parent linked — the original conversation is never modified and stays in the list). Continue there with a different prompt while the old path remains intact; the ⟲ restore button on the start message is still there if you also want to rewind the files.
- The three user-message actions now live together in the message header, revealed on hover: **✐ edit**, **ᛉ fork** and **⟲ restore** (the latter only when a git checkpoint exists).

## 1.8.1 — 2026-10-01

- **Dev servers now run in a visible VS Code terminal** — until now `npm run dev` / `npm start` / `serve` / `watch` / `preview` commands were started as detached background processes: the AI got the PID and the early output, but **you saw nothing** — no compile progress, no errors, no "ready" URL. Every long-running command now starts in a dedicated, **visible terminal** (named `AI Bridge: dev` / `AI Bridge: serve` / … in the bottom panel): you watch the live output and **Ctrl+C in that terminal stops the server** exactly like a command you typed yourself. The server keeps running after the AI finishes — stop it with Ctrl+C or with `AI Bridge: Stop Dev Servers`, which now sends Ctrl+C to each server's terminal and only closes the terminal if the process ignores it.
- **Live capture via the stable Shell Integration API** — the first ~3 s of output (plus the detected **live URL** and fast startup errors like "port already in use") are captured with the standard Shell Integration API (`terminal.shellIntegration.executeCommand()` + `execution.read()`, VS Code 1.93+). The implementation deliberately avoids `onDidWriteTerminalData`, which is still a *proposed* API — for a sideloaded VSIX it is silently filtered out at runtime unless VS Code is launched with `--enable-proposed-api`, so it could never capture anything in normal use. If shell integration is unavailable for a shell, the command still starts visibly and the AI gets a `⚠️` note that live capture was off (instead of silently losing the output).
- **Friendlier failure handoff** — when the process exits during the grace window (occupied port, syntax error, missing deps) the AI receives the full captured output, the exit code and a note that the terminal stays open so you can read the errors yourself; the terminal is no longer closed automatically. Anti-duplication, the stop command and the `DEV-SERVER NOTE` self-correction flow keep working — servers are now identified by their terminal name instead of PID.

## 1.8.0 — 2026-10-01

- **Chrome now runs completely in the background — no more taskbar button** — until now the window was only parked offscreen (`-32000,-32000`), which still left a visible taskbar entry. The window is now **minimized** (CDP `Browser.setWindowBounds`) and on Windows its taskbar button is removed entirely by setting `WS_EX_TOOLWINDOW` on the main window (a small `user32.dll` helper driven by PowerShell `Add-Type` — the same native-helper pattern as the v1.7.3 audio recorder); the window also disappears from Alt+Tab. `--start-minimized` is now part of the launch flags as well (Chrome ignores it for windows created later, so the explicit CDP minimize right after connect covers that path).
- **Automation, rendering and page JS are unaffected** — verified E2E: with the window minimized + taskbar-hidden the page keeps executing timers, `document.visibilityState` stays `visible` (thanks to the existing `--disable-backgrounding-*` flags) and CDP/Playwright control (evaluate, screenshots, clicks) keeps working; the offscreen position stays as a second safety net.
- **Show Chrome restores everything** — 👁 Show Chrome, the login assist and the new CAPTCHA assist bring the window back on screen (normal state + taskbar button + focused tab) so you can interact with it, then hide it to the background again afterwards.
- **CAPTCHA auto-show** — when a provider page presents a real CAPTCHA challenge (reCAPTCHA challenge frame, hCaptcha challenge, Cloudflare “Just a moment”/challenge page, DataDome), AI Bridge now brings Chrome on screen automatically (same pattern as the login assist), waits for you to solve it (up to 5 minutes, URL/DOM polled every 2.5 s), then hides the window again and continues by itself. Detection is conservative — the invisible reCAPTCHA v3 badge / hidden widgets never trigger it. Stop aborts the wait and hides the window immediately.
- **Auto-accept for consent popups** — cookie banners and terms/consent dialogs are now closed automatically: after a page load, before clicking New Chat and right before typing a message. Three confidence tiers — strong (“Accept all”, “Accept all cookies”, “Acceptă toate”), medium (“Accept”, “I agree”, “Got it”), weak (“OK”, only inside dialogs/banners/modals) — with exact matching on the normalized button text, links only for the top tier, and refusal wording (Reject / Only necessary / Customize / Manage settings / Not now / Close…) never clicked; cross-origin iframes are scanned too (Google's consent banner lives in one). At most 3 clicks per pass, and every clicked element is marked (`data-aibridge-accepted`) so the same button is never pressed twice. Disable with the new `aiBridge.autoAcceptPopups` setting (default on).
- A chat notice reports popups closed during a send and the CAPTCHA wait/solved/expired states.

## 1.7.5 — 2026-10-01

- **Restore button icon changed to ⟲ (U+27F2)** — the checkpoint restore button on user messages now shows the anticlockwise gapped circle arrow instead of the previous emoji; the same symbol is used in the restore confirmation dialog, the “checkpoint restored” notice, the missing-git explanation and the settings / README descriptions. No logic changes (the ✅ marker shown after a successful restore stays as it was).

## 1.7.4 — 2026-10-01

- **Long-running commands no longer block the AI — dev servers run in the background** — `npm run dev`, `npm run serve`, `npm start`, `watch` / `preview` scripts and known dev binaries (`vite`, `nodemon`, `next dev`, `astro dev`, `ng serve`, `uvicorn`, …) are now detected **before** execution and started with `spawn` instead of being awaited by `exec` (previously: 60–180 s timeout → the agent loop stalled on a command that never exits). On macOS/Linux the child is `detached` (own process group); on Windows it runs as a plain background child — `detached` + `cmd.exe` silently loses the process output (verified during development), so capture uses the non-detached shell and stopping is done with `taskkill /T`. The AI immediately receives `✅ Server pornit în background (PID: …)`, the detected live URL(s) and the first ~2.5 s of output — so fast startup errors (port already in use, syntax error, missing deps) are still captured and reported as a normal failed command with the self-correction directive.
- **Detection by script name + word patterns** — exact names (`dev`, `start`, `serve`, `watch`, `preview`, `storybook`, `develop`, `nodemon`, `hot`, `live`, `start:dev`, `dev:server`) plus `\bdev\b` / `\bserve\b` / `\bstart\b` / `\bwatch\b` / `\bpreview\b` patterns (`dev:client`, `test:watch`, `start:prod` …). Works for `run_npm` script calls and for raw `run_command` strings: `npm/pnpm/yarn/bun [run] <script>`, chains (`cd app && npm run dev`, `npm install && npm run dev`), `npx vite`, bare binaries (`vite`, `parcel`, `nodemon server.js`), `--watch` flags (`npm run build -- --watch`, `tsc --watch`) and Python (`manage.py runserver`, `flask run`). One-shot subcommands (`vite build`, `next build`, `wrangler deploy`) are never misdetected.
- **New command `AI Bridge: Stop Dev Servers`** (also in the chat view title) — stops every dev server the extension started: tree kill on Windows (`taskkill /PID … /T /F`) and process-group `SIGTERM` → `SIGKILL` on macOS/Linux, with per-PID reporting of the stopped and failed ones. The same server (command + folder) is never started twice while it is still running (the AI gets the existing PID instead).
- **No orphaned processes** — the process registry is in-memory, so on window close the remaining servers are stopped best-effort; output pipes are capped (48 KB) and unref'ed after the grace window, so the detached server keeps serving without holding the extension host.

## 1.7.3 — 2026-10-01

- **Voice input repaired — audio capture moved to the Extension Host** — the 🎤 button no longer records inside the webview (`getUserMedia` / `MediaRecorder` are blocked by the VS Code sandbox → `NotAllowedError`, no microphone access). Capture now runs in the extension's own Node.js process, which always has access to the system microphone.
- **Native Windows capture with zero dependencies** — on Windows the recording is done by a small C# recorder over `winmm.dll` (the classic waveIn API), compiled at runtime by PowerShell `Add-Type` from a script generated by the extension: 16 kHz mono 16-bit WAV, ready for whisper.cpp — no SoX, nothing to install. (The npm `node-audiorecorder` package was investigated for this exact job, but it is unmaintained, is based on node-record-lpcm16 and still requires SoX (`rec`) on every platform — its code contains no native Windows backend, so it could not replace SoX.)
- **Cross-platform fallback** — on macOS/Linux (or Windows without PowerShell) the capture falls back to `node-audiorecorder` (SoX `rec`) when it is available in PATH; streaming RIFF sizes written by SoX into the pipe are repaired after capture.
- **Same recording UX, clearer failures** — 🎤 starts the capture (`🎤 Pornesc microfonul…` → `🎙 Se înregistrează… (m:ss)` with a pulsing button and live timer; stop with ⏹ or by sending a message), then `⏳ Transcriu audio (Whisper local)…` while whisper.cpp transcribes locally and the transcript is appended to the message box. Missing microphones, permission problems and script errors surface as clear chat notices, and a 10-minute safety limit auto-stops runaway recordings (the transcript still arrives).
- The obsolete `stt_audio` webview→host base64 audio path and the in-page WAV conversion were removed; `aiBridge.sttLanguage` is now read by the extension at transcription time.

## 1.7.2 — 2026-10-01

- **Voice input rebuilt on local Whisper (100% offline)** — the 🎤 button no longer uses the Web Speech API (unavailable in Electron without Google services). It now records with **MediaRecorder** in the webview, converts the audio to 16 kHz mono WAV in-page (decode + resample; no ffmpeg needed) and sends it to the extension, which transcribes it with **whisper.cpp** — fully offline, Romanian + English.
- **One-time setup command** — `AI Bridge: Setup Local Whisper` downloads the official prebuilt whisper.cpp binaries (v1.9.2, BLAS x64, ~20 MB) and the `ggml-base` model (~141 MB) into global storage; the engine is resolved automatically afterwards (settings → global storage → classic whisper.cpp locations → PATH).
- **Recording UX** — the button shows ⏹ + a pulsing red state while recording and the input shows a live timer (`🎙 Se înregistrează… (0:07)`); while transcribing it shows ⏳ / `Transcriu audio (Whisper local)…`, and the transcript is appended to the message box. Microphone, permission, conversion and engine errors all produce clear chat notices.
- **Why not nodejs-whisper** — it builds whisper.cpp via CMake at runtime (needs a build toolchain); v1.7.2 drives the same upstream engine through the official prebuilt binaries instead. `aiBridge.whisperCliPath` / `aiBridge.whisperModelPath` accept any custom whisper.cpp build.
- The Web Speech API code path was removed; `aiBridge.sttLanguage` now selects the Whisper language (applied at the next transcription).

## 1.7.1 — 2026-10-01

- **Verbose mode (diagnostic transparency)** — a new 🔍 toggle in the toolbar shows every step the AI takes, live in the chat, grouped by type: **🧠 Thinking** (the model's reasoning), **⚙️ Executing** (tool runs with the exact command/target), **📄 Result** (tool output previews, capped at 4 000 chars) and **🔀 Decision** (tool choice, auto-retry, auto-repair and rollback decisions). Every step is collapsible (click its header); running steps pulse until they finish and long steps (Thinking / Result) fold themselves automatically. Off by default = only the final answers, exactly as before — the toggle is persisted across sessions.
- **Reasoning capture (DeepSeek-R1 / Claude extended thinking / Gemini / Qwen / Kimi / Ollama)** — providers now expose the model's thinking separately from the final answer: `AIProvider.onThinking` is called by web providers with the reasoning block extracted from the page (per-provider selectors + generic fallbacks, echo- and UI-safe, best-effort) and by local Ollama models with the `thinking` / `reasoning_content` field. It shows up as a single collapsed 🧠 Thinking card per prompt (accumulated across the agentic loop).
- **Chat ordering** — verbose step cards are inserted between your message and the in-progress answer, so the process reads top-to-bottom: prompt → steps → final reply.

## 1.6.0 — 2026-10-01

- **Voice input (speech-to-text)** — a new 🎤 button next to the attachment buttons dictates your message with the Web Speech API: interim results preview live in the input placeholder, finalized phrases are appended to the message box (whatever you already typed — or dictated earlier — is kept), and the textarea grows/scrolls like normal typing. Click the button again to stop; sending a message or clearing the chat stops listening automatically, and the button turns red with a soft pulse while recording.
- **Romanian + English** — pick the dictation language with the new `aiBridge.sttLanguage` setting (`ro-RO` default, `en-US`); the change applies live, without reloading the webview.
- **Safe failure modes** — environments without the Web Speech API, a blocked microphone or a missing speech service produce a clear chat notice instead of a silent no-op; transient `no-speech` events simply keep the session alive, and fatal errors stop the session cleanly (the browser-side auto-restart can never loop).

## 1.5.0 — 2026-10-01

- **Restore button now always appears — automatic `git init`** — before this release, projects that were not git repositories silently skipped checkpoint creation, so the 🔄 restore button never showed up (no error, no explanation). Now, with `aiBridge.autoInitGit` on (default), the folder gets a `git init` (plus a minimal `.gitignore` if none exists, so `node_modules/` and build output stay out of the first commit) right before the first checkpoint, and the chat announces it. If git is missing entirely, a one-time chat notice explains why there is no 🔄 button.
- **Hardened message↔checkpoint wiring** — the user-message id is attached to the chat bubble directly in `add()` (one single code path), and restore buttons are re-attached after every user message, so the 🔄 button can no longer miss its checkpoint because of message ordering (e.g. right after a webview reload).
- **Text-to-speech for AI replies** — every assistant message gets a 🔊 button (next to Copy) that reads the answer aloud via the Web Speech API, with a Romanian voice when one is installed (`ro-RO`). Long answers are split into sentence-sized chunks so speech engines don't cut them off, and markdown (code blocks, links, emphasis) is stripped first. Click the button again to stop; reading also stops when you clear the chat or send a new message.

## 1.4.0 — 2026-10-01

- **Automatic git checkpoint before every prompt** — right before your message is sent, AI Bridge snapshots the project in git with a temporary marker commit (`aibridge-prompt:<id>`): a dirty working tree is committed as-is (the checkpoint is exactly what you had before the prompt) and a clean tree gets an empty marker commit — every prompt gets its own unique restore id. Repos without a configured git identity are handled automatically (bot identity fallback). No-op in non-git projects; toggle with `aiBridge.promptCheckpoints`.
- **One-click restore in the chat** — every user message with a checkpoint shows a small 🔄 button above it (re-attached to historical messages after a chat reload, via global state). Clicking it asks for confirmation and runs `git reset --hard <checkpoint>`, bringing the project exactly back to the state before that prompt. The current state is first saved as an automatic backup commit (`aibridge-backup-before-restore:<ts>`) whose short hash is shown in the chat — nothing is lost. Untracked files are left on disk and reported.
- **Checkpoint history** — the last 50 checkpoints (message id, prompt snippet, commit hash, timestamp, dirty/clean flag) are persisted in global state.

## 1.3.0 — 2026-10-01

- **Auto-verify after every edit** — after each `edit_file` / `write_file` / `write_files` the project is checked automatically: `astro check` (when `@astrojs/check` is installed), `tsc --noEmit` (Next / Vite / any tsconfig project with TypeScript), or the detected `typecheck` / `build` / `lint` script — picked from `package.json`, dependencies and lockfile (`npm` / `pnpm` / `yarn`), with a 120 s timeout. Results appear in the chat and in the Output channel.
- **Auto-repair loop** — when the check fails, the **full error output** goes back to the AI with an `AUTO-REPAIR` directive (find the root cause → fix with `edit_file` / `write_file` → the system re-verifies automatically). Max **3 auto-repair attempts** per failing streak; a recovery is announced in the chat (`✅ Auto-verify … passes again`).
- **Automatic rollback** — if the project still fails after 3 repair attempts (or the model stops with the check still red), all edits made since the last passing verification are **rolled back automatically** to the last known-good state (pre-edit snapshots are taken before every write; brand-new files are deleted), the user gets a VS Code warning, and the chat shows exactly what was reverted plus the last error. The project is never left broken.
- **Safety net details** — verification is skipped when no check can be detected (e.g. plain Python) and can be disabled with the new `aiBridge.autoVerify` setting (default on).

## 1.2.1 — 2026-10-01

- **In-chat Accept / Reject for diff reviews (fallback for the VS Code notification)** — when a file write opens the native diff, the decision buttons now also appear **directly in the chat**: an inline review card with a diff preview and **✓ Accept / ✗ Reject**. It shows **in parallel** with the usual VS Code notification (which is often hidden, expires or never renders) and **whichever you click first decides the review** — both paths resolve the exact same pending approval. Dismissing the notification no longer ends the flow on a fallback card: the chat card stays active until you decide, Stop / ⚡ auto-approve still resolve it instantly, and the card is re-posted automatically if the webview reloads while the review is pending.

## 1.1.2 — 2026-10-01

- **Forced tool calls (rewritten system prompt)** — the model must answer every action request with a **single-line tool-call JSON** (`{"tool": "NAME", "args": {...}}`) — no introductions, no “Analyzing… / Let me… / I'll…”, no markdown fences — and gets strict **workflow examples** (search → read → edit, file creation, comment insertion, running tests). `PROJECT INFO` / `PROJECT STRUCTURE` are now injected through `{PROJECT_INFO}` / `{PROJECT_STRUCTURE}` placeholders inside the prompt itself.
- **Auto-retry when the reply contains no tool call** — if the model replies with descriptive text (“Analyzing the project structure…”) or a malformed JSON fragment instead of a tool call, AI Bridge automatically sends a strict **“NO TOOL CALL DETECTED”** nudge that demands exactly one single-line tool call (max 2 per message, visible in chat as `🔁 Auto-retry n/2`). Genuinely final answers pass through untouched.

## 1.1.0 — 2026-10-01

- **MCP (Model Context Protocol) client** — AI Bridge can now launch user-configured MCP servers (stdio transport, JSON-RPC 2.0 over newline-delimited messages), discover their tools (initialize handshake → `tools/list`, cursor pagination supported) and **expose them to the model as extra tools** named `mcp_<server>_<tool>`. The tool list (names, parameter names, short descriptions) is appended to the system prompt on every message — with a tighter cap for local Ollama models; the generic `{"tool":"mcp_call","args":{"server","tool","arguments"}}` alias is also accepted.
- **Configuration** — servers are read from **`.vscode/mcp.json`** (VS Code format `{"servers": {...}}`; the Claude-Desktop `{"mcpServers": {...}}` shape is accepted too) or from the new **`aiBridge.mcpServers`** setting. The file watcher + settings listener hot-reload everything (debounced), `aiBridge.mcpEnabled` is the master switch and `aiBridge.mcpToolTimeoutSeconds` (default 60) caps each `tools/call`.
- **Approval-based execution** — every MCP call goes through the same approval flow as shell commands (card shows server, tool and arguments; ⚡ auto-approve applies automatically); results and failures return to the model as normal `TOOL_RESULT` / `TOOL_ERROR` messages, so the agentic loop keeps working.
- **Management UI** — new command **`AI Bridge: MCP Servers`** (also in the view title toolbar): per-server status (🟢 running / 🔴 failed / ⚪ stopped), restart / stop / show tools per server, "restart all", "show all tools", "open or create `.vscode/mcp.json`". MCP status also appears in **Show Provider Status** and **Diagnostics**.
- **Robustness** — spawn failures fail fast (no timeout hang), crashed servers are reported with their stderr tail, in-flight requests are rejected when a server exits, unsupported server→client requests (sampling/roots) get a proper JSON-RPC error, and Windows `.cmd` shims (`npx`, `npm`, ...) are launched through a shell with quoted arguments.

## 0.9.5 — 2026-10-01

- **AI-powered selector discovery (fallback)** — when the classic fingerprint healer finds no candidate at all (or every candidate is dropped by the blacklist/fragile rules), AI Bridge now captures a **cleaned DOM snapshot** of the page (scripts/styles/SVG/cookie banners stripped, `on*`/`style`/`data-react*` attributes and input values removed, head+tail capped to fit the local model context) and asks the local **Ollama** model (`aiBridge.ollamaModel`) for stable selectors — `input` / `response` / `newChat` / `stopButton`. Proposed selectors are validated against the live page (must exist, be visible, be unique enough, be editable for `input`, carry real text for `response`) and re-checked with the same safety guards as the healer (promo/blacklist/fragile/echo rules, no user bubbles); only then are they applied immediately, persisted with the other learned overrides and written to **`selectors-user.json`** in global storage (auto-reloaded at startup, invalid entries pruned automatically).
- **Fail-open and rate limited** — the fallback never blocks the normal flow: at most one attempt per provider/slot/site every 5 minutes, a configurable timeout (`aiBridge.aiFinderTimeoutSeconds`, default 45 s, Ollama call is aborted on expiry), and it is skipped silently when Ollama is not reachable. Toggle with `aiBridge.aiSelectorFinder` (default on).

## 0.9.4 — 2026-10-01

- **Promotional cards can no longer be picked as the reply (Kimi)** — marketing/upsell tiles (e.g. Kimi's `div.resource-placement-card__content` showing “Invite to Earn / Get Membership Benefits”) matched the `response` fingerprint (text + `<p>` children) and — once learned — were read back instead of the real answer. The healer blacklist now covers promo/marketing attributes (`invite`, `earn`, `membership`, `benefit`, `offer`, `upgrade`, `premium`, `subscribe`, `pricing`, `plan`, `resource-placement`, `cta`, `call-to-action`, `reward`, `referral`, `coupon`, `discount`, `trial`), and previously learned promo selectors for `response`/`input` are purged automatically at startup.
- **Promo blocks with innocent class names are rejected by their text** — some upsell widgets carry no suspicious attribute (e.g. Kimi's `div.rat-carousel__track` carousel), so `response` candidates are additionally screened for multi-word marketing phrases (`invite to earn`, `membership benefits`, `upgrade to premium`, `refer a friend`, …). Single words like `premium` or `upgrade` in a real technical reply never trigger it, and the generic rescue extraction stays as the safety net.
- **Conversation containers are never learned as the reply** — when the healer runs mid-generation on a fresh chat, elements whose text starts with the just-sent message (e.g. Kimi's `div.chat-content-list` holding the whole conversation) are rejected by the same echo rule the reader uses (min. 40 chars).
- **No false rejections** — `earn`/`plan`/`cta`/`trial` only match at a word start, so legitimate names like `learn-more`, `explanation`, `octagon` or `industrial` are never misclassified by the healer.

## 0.9.3 — 2026-10-01

- **Kimi: the reply is now read correctly (no more “the answer is my own message”)** — `kimi.response` was rewritten for the real `www.kimi.ai` DOM: the reply is read from the assistant side only (`.chat-content-item-assistant .markdown-container:not(.toolcall-content-text) .markdown`, with scoped fallbacks), and the thinking block (`toolcall-content-text`) is skipped. The old broad selectors (`[class*='segment']`, `[class*='markdown']`) also matched the **user bubble**, so while Kimi was still thinking the reader could pick up the just-sent message (+ its “Edit/Copy/Share” action labels) and, because the labels defeated the echo check, return it as the final answer. Bundled config version bumped 1.3.0 → 1.4.0.
- **The healer can no longer learn the input box as a response** — response candidates are rejected if the element itself is editable or `role="textbox"` (e.g. Kimi's Lexical composer `div.chat-input-editor`), or if any ancestor carries a `user` class token (`.user-content`, `.segment-user`, `.chat-content-item-user`). Learned overrides for `response` that look like input selectors (`textbox` / `composer` / `chat-input` / `contenteditable`) are rejected and previously learned ones are **purged automatically at startup**.
- **Echo check hardened** — a read that equals the sent message *or starts with it* (user bubble + action labels suffix) is never treated as a response, before heal-probe acceptance, during stability detection and in the rescue extraction; the 25 s Enter retry re-focuses the composer first (a stuck message in the input is actually re-sent).

## 0.9.2 — 2026-10-01

- **Kimi international endpoint** — the Kimi provider now uses `https://www.kimi.ai/` (international site) instead of `https://kimi.com/` (China mainland, not reachable from most regions). The bundled `selectors.json` URL is updated and its config version bumped (1.2.0 → 1.3.0), so the fix also wins over an older cached remote selector config.

## 0.9.1 — 2026-10-01

- **Auto-show Chrome at login** — when a web provider lands on a login/auth page (e.g. Mistral, Qwen or Kimi not yet signed in), AI Bridge now brings the hidden Chrome window on screen automatically, posts a chat notice, waits for the login (URL polling, up to 5 minutes) and then hides the window offscreen again and continues by itself. Pressing Stop aborts the wait and hides the window immediately.
- **Mistral selector fixes** — better `response` / `newChat` alternatives in `selectors.json`; the healer blacklist now also covers theme/UI chrome (`theme`, `toggle`, `dark`, `light`, `mode`) and secondary text blocks (`subtle`). `dark`/`light`/`mode` are matched as full tokens only, so Tailwind `dark:...` classes, `font-light`, `highlight` and `model` selectors are never misclassified. Selectors containing theme/toggle tokens are rejected when the healer tries to persist them, and previously learned bad overrides (Mistral's `Toggle theme` as newChat, `text-subtle` as response) are purged automatically at startup.

## 0.9.0 — 2026-10-01

- **Three new browser providers** — **Mistral (Vibe)** (`chat.mistral.ai`), **Qwen** (`chat.qwen.ai`) and **Kimi** (`kimi.com`) join DeepSeek, ChatGPT, Gemini and Claude. They run through the same hidden Chrome/CDP pipeline (human-like typing, selector self-healing, native diff approvals), appear in the provider dropdown and can be used as the first hop of the **Auto** chain (last used web provider → Ollama).
- **`preferredKeywords` for selector healing** — selector slots can now declare preferred keywords (e.g. `assistant`, `markdown`, `chat`); during auto-repair, candidates matching them in their own attributes (class/id/aria-label/placeholder) get a scoring bonus. Bundled for the new providers and carried through remote Gist configs.

## 0.8.1 — 2026-10-01

- **MutationObserver is now opt-in — `aiBridge.mutationObserver` default changed to `false`.** The observer proved flaky while Chrome runs offscreen (at `-32000,-32000` Windows suspends JavaScript for invisible windows, so the “quiet DOM” signal wasn't always delivered and the wait could stall). The reliable 500 ms polling is the default again; set `aiBridge.mutationObserver` to `true` to opt back into the experimental fast detection.

## 0.8.0 — 2026-10-01

- **Human-like typing** — messages are typed character by character with randomized delays (15–50 ms), punctuation pauses and occasional fast bursts instead of instant insertion (anti-detect); typing can be cancelled with Stop (partial input is cleared best-effort) and messages longer than 1500 chars (e.g. embedded attachments) fall back to instant paste. Toggle: `aiBridge.humanTyping` (default on).
- **Instant completion detection (MutationObserver)** — the response wait is now driven by an in-page MutationObserver: a quiet DOM ends the wait step immediately instead of a fixed 500 ms poll (much less CPU). Selector healing checkpoints, the 25 s Enter retry, the 2 s text-stability rule and the rescue extraction all stay. Toggle: `aiBridge.mutationObserver` (default on; off = classic polling).
- **Human-like behavior** — small randomized mouse moves before clicking the composer, New Chat and Stop, plus an occasional gentle scroll. Toggle: `aiBridge.humanBehavior` (default on).

## 0.7.1 — 2026-10-01

- **24 h rate limit for the startup selector check** — the automatic check at activation runs at most once every 24 hours (any check — manual or automatic — resets the timer); `AI Bridge: Update Selectors` always works on demand and reports the result.

## 0.7.0 — 2026-10-01

- **Remote selector config (GitHub Gist)** — selector fixes are now deployable to every client **without an extension update**: point `aiBridge.selectorsUrl` at a public Gist whose `selectors.json` carries a `version` (plus optional `updated` / `changelog`). New versions are downloaded, strictly validated, merged over the bundled config and cached in global storage; the bundled selectors remain the fallback when the Gist is missing, older or unreachable.
- **`AI Bridge: Update Selectors` command** (also in the view title) — manual update from the configured Gist, showing the version transition and the changelog.
- **Optional startup check** — `aiBridge.checkSelectorsOnStartup` (default `true`) refreshes selectors silently at activation; local auto-repairs for the slots a remote update touches are replaced by the curated fix, and diagnostics now report the active selector source.

## 0.6.1 — 2026-10-01

- **Tolerant tool-call parsing** — recovers tool calls when the model omits escaping around double quotes inside JSON string values.

## 0.6.0 — 2026-10-01

- **Terminal self-correction (auto-healing)** — when a command fails (`run_command`, `run_npm`), the AI receives the **FULL output** (stdout and stderr separately, exit code, duration — no more bare “exit code 1”) plus a **SELF-CORRECTION directive**: find the root cause → fix the code (`edit_file` / `write_file`) → re-run the same command.
- **Hard retry limit** — max **5 attempts per command** (per message). After 5 failures the command is **blocked**: running it again returns an error instead of executing, and the model must reply with plain text explaining what remains broken.
- **Visible healing status in chat** — `⟳ Auto-healing 2/5: “npm run build” failed (exit 1, 3.4s)…`, `✅ fixed after N attempts`, `⛔ command blocked`. Counters reset on success and at every new message.

## 0.5.0 — 2026-10-01

- **Native diff review** — file writes (`write_file`, `edit_file`, `write_files`) no longer use the in-chat text card. AI Bridge opens a **native VS Code diff editor** (left = current content, right = proposed content; the real file is untouched until you accept) and asks with **Accept / Reject** buttons. Multi-file batches open the multi-diff view.
- **"Accept (don't ask again)"** — per-file opt-out from the diff notification, persisted across sessions. New command **`AI Bridge: Clear No-Ask File List`** resets it (also in the view title toolbar).
- **Safe fallback** — if the diff can't be opened, or the notification is dismissed without a choice, the classic in-chat approval card still handles the decision.
- Command (`run_command`, `run_npm`) and git approvals keep their in-chat cards.
- Stop now cancels a pending diff review immediately; enabling ⚡ auto-approve accepts one that is pending.

## 0.4.0 — 2026-10-01

- **Auto provider** — new dropdown mode: tries the last used web provider through Chrome first, then falls back to local Ollama automatically (chat notices when a fallback happens).
- **Status badge** 🟢🟡🔴 next to the provider picker — live Chrome/CDP and Ollama availability; click it for a detailed report.
- **Show Chrome** — new command + 👁 toolbar button: moves the offscreen Chrome window back on screen and focuses it.
- **Show Provider Status** — detailed report (CDP port, DeepSeek login, Ollama models) written to the AI Bridge output channel and into the chat.
- **Configurable Ollama URL** (`aiBridge.ollamaUrl`, default `http://localhost:11434`).

## 0.3.0 — 2026-09-30

First commercial-readiness pass (all P0 findings from the audit):

- **Portability** — Chrome/Edge auto-detection on Windows, macOS and Linux; the browser profile moved from the project folder to VS Code global storage; configurable CDP port (`aiBridge.cdpPort`) and optional binary override (`aiBridge.chromePath`).
- **Close Browser really closes** the browser now (CDP `Browser.close`, with a hard fallback that kills the PID listening on the CDP port).
- **Security** — extension now requires a trusted workspace; the webview gets a strict CSP; enabling ⚡ auto-approve asks for explicit confirmation.
- **Diagnostics** — new `AI Bridge: Diagnostics` command plus a dedicated "AI Bridge" output/log channel for all extension logs.
- **Guardrail** — total time budget per message (`aiBridge.messageTimeoutMinutes`, default 20 min).
- **Project hygiene** — `.gitignore`, README, LICENSE, CHANGELOG, Marketplace icon; old build artifacts removed.

## 0.2.1 — 2026-09-30

- Auto-approve toggle; anti-spam write limits (3/file, 15 ops/message); stricter system prompt for local models.

## 0.2.0 — 2026-09-30

- Local provider (Ollama) — no browser required.

## 0.1.x — 2026-09-30

- Attachments (files/folders/images/drag & drop), agentic loop (40 steps), npm/git/batch file tools, streaming progress, project detection.
- Git short-form tool calls fix; separate file/folder attach buttons.

## 0.0.x — 2026-09-30

- Initial releases: chat view, web providers (DeepSeek/ChatGPT/Gemini/Claude), selector self-healing, hidden offscreen Chrome.
