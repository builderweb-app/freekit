# Changelog

## v2.5.23

- FIX (bug #54, part 2): **every tool that returns text to the AI now respects the same payload budget.** v2.5.22 capped `read_file` / `read_files`, but the other payload producers were still wide open (`attachments` allowed **30 000 chars/file and 150 000 total**, `list_files` had no cap at all, `run_command` / `run_npm` sent up to 24 000, MCP tool results 20 000, dev-server output 20 000, `git diff` the whole diff). A single big paste makes the web apps (ChatGPT / Claude / Gemini) process the reply for minutes on **every** later message. All of them now go through the shared budget in `src/payload.ts` — **`MAX_CHARS_TOTAL = 12000`**, **`MAX_CHARS_PER_FILE = 6000`**, **`MAX_LINES_PER_FILE = 500`** — with **head + tail** truncation (the tail holds the tsc/build error summary that a head-only cut threw away) and an explicit `... [truncated N chars] ...` marker. Concretely: attachments (6000/file, 12 000 total, remaining files are marked `[SKIPPED: payload limit reached]` instead of being sent), `list_files` (1000 entries + budget), `search_files` (100 matches, 400 chars/line — a minified file can no longer return a 100k-char line), `run_command` / `run_npm` (6000 per stream, 12 000 total), `search_semantic`, `git status` / `diff` / `log`, MCP tool results, dev-server startup output and the auto-verify output.
- FEAT: **the web chat is rotated proactively, before it becomes slow.** Tool results are pasted into the browser chat one after another and the accumulated context is exactly what makes ChatGPT/Claude/Gemini slow (`Chat memory full` is the extreme case). After **4 tool results in the same browser chat** (`freekit.newChatAfterToolCalls`, 0 = disabled, max 40) Freekit opens a **new chat**, prefixes the pending step with a compact handoff (original task + the steps just done + the conversation recap — the same mechanism as the „Chat memory full” card, but without asking) and continues there, so the paste stays small and fast. The rotation is best-effort: if the new chat cannot be opened, the task continues in the current chat; the counter is per browser chat (it resets on a new chat, on Clear / Edit prompt / checkpoint restore, on a memory-full restart and when switching the VS Code conversation), and it is skipped entirely for local providers (Ollama) that have no browser chat.

## v2.5.22

- FIX (bug #54): **a large tool payload made every model respond slowly.** A `read_files` call could return ~40 000 characters, and the web apps (ChatGPT / Claude / Gemini) take minutes to process such a paste — in the log, `read_files → result 40046 chars` was followed 2 min 18 s later by the reply, while the model itself had answered immediately in the browser. `read_file` and `read_files` now truncate **head + tail** (≈60 % beginning + ≈30 % end, with a `... [truncated N lines + M chars] ...` marker in the middle) instead of keeping only the beginning, and the batch has a hard budget: `MAX_LINES_PER_FILE = 500`, `MAX_CHARS_PER_FILE = 6000`, `MAX_CHARS_TOTAL = 12000` — files that no longer fit are returned as `[SKIPPED: payload limit reached]` instead of being sent. Verified: a 40 046-char batch (12 × ~109 k-char files) now returns **11 480 chars** (2 files included, 10 skipped), so the paste stays small and fast on all providers. Small files are passed through unchanged.

## v2.5.21

- FIX (bug #52 + #53): **typing was slow on large payloads.** Tool calls embed huge prompts (e.g. `40046` chars): `humanType` still typed a „human” head character-by-character before pasting the rest, so the log read `typing 27/40046 chars with human delay` → `pasted the remaining 40019 chars` **2 min 18 s** later — and with 5 tool calls a turn took 12+ minutes. Messages **larger than `MAX_TOTAL_NATURAL` (1000 chars)** are now pasted **directly in a single `insertText`, with no natural typing at all**; below that threshold only the first **`NATURAL_TYPING_MAX_CHARS` (100)** characters are typed naturally (previously a random 30–50 head), which also makes medium prompts (200–1000 chars) paste the remainder instead of typing it. Normal messages (≤ 100 chars) are still typed entirely with real key events, and the first-`\n` guard from v2.5.14 is preserved (the natural head never crosses a line break; `insertText` handles the rest, so a pasted `\n` never acts as Enter).

## v2.5.20

- FIX (bug #44/#58): **the `response` auto-heal ran before the reply was rendered.** The first heal checkpoint fired 4 s after Enter, when the assistant bubble simply does not exist yet (sites render it in 2–10 s): `anySelectorMatches` was false, so the healer logged „no candidate for chatgpt.response — trying AI finder" and burned the **whole AI-finder timeout (45–120 s)** on a DOM snapshot with no reply in it — for a selector that was never broken (verified: the bundled `[data-message-author-role='assistant']` matched as soon as the bubble appeared at ~6 s, and the reply was read only after the finder gave up). The `response` slot is now **no longer healed at the early 4 s / 9 s checkpoints** — repair starts only at the **20 s** checkpoint (and is retried at 40 s), by which time a rendering delay can no longer be mistaken for a broken selector. Known page errors (rate limit / out of messages / „Chat memory full" / CAPTCHA) are still detected at every checkpoint, including 4 s and 9 s, so the error card shows without delay.
- FIX (bug #44/#58): **the AI finder no longer runs when there is nothing to find.** As a second guard, before calling it for the `response` slot Freekit probes the page (substantial text outside the navigation, different from the message just sent) and skips the expensive call — with an explicit log line — when the DOM still has no reply to locate. A static selector that already worked in a previous session is therefore never replaced just because its bubble has not rendered yet, and a bogus selector can no longer be „learned" off an error/empty page.

## v2.5.19

- FIX (bug #48): **the „Chat memory full" card was skipped (regression from v2.5.15)** — the full-chat banner was only handled on the *first* send of a turn; when it was detected on a follow-up send (tool-result message, refusal / text-retry nudge, malformed-JSON retry, auto-repair of a failed check), those calls did **not** pass `onMemoryFull`, so `restartInNewChat` fell back to „cancel": plain notice text („memory full — stopped; the next message will start a new chat") plus an auto-cleared browser chat, with **no 💬 New chat & continue / 🌐 Show Browser / ⏹ Stop card**. All secondary sends now reuse the same decision callbacks (`onMemoryFull`, `onLoggedOut`, `onNotice`, `onProgress`), so the card appears whichever send trips the banner and the loop can continue in a new chat with the handoff. The Stop / restart-limit fallback (notice + forget the browser-chat reference) still behaves as before.

## v2.5.18

- FIX (bug #49): **verbose steps were squashed into thin lines** when the chat content exceeded the panel — the chat is a scrollable flex column, and cards with `overflow: hidden` (like `.vstep`) get an automatic minimum size of 0, so flexbox compressed every step to ~2px instead of scrolling. All direct children of the chat are now `flex-shrink: 0`: measured live with 30 steps + a long reply, every card keeps its height (32px when collapsed) and the chat scrolls.
- Verbose steps are now **compact 1-row cards (32px collapsed) with a chevron on every step** (▼ expanded / ▶ collapsed; previously only the „Thinking" card had one). Click — or Enter/Space — toggles the details, and `aria-expanded` is kept in sync.
- **Auto-collapse at the end of every turn** — on reply / Stop / error all steps fold to their 32px header row so the chat stays clean; the per-step auto-collapse of finished `Result` steps is kept.
- **Summary in the collapsed header** — the first line of the step details (up to 90 chars, hover for the full text) is shown next to the title while the step is collapsed, and hidden again when expanded.

## v2.5.17

- FIX (bug #43): **„not ACTUALLY available" refusals were still treated as answers.** The v2.5.16 patterns required the negation and „available" to be adjacent, so „the VS Code workspace tools you specified (read_file, list_files, etc.) are not *actually* available in this chat session" slipped through. `TOOL_REFUSAL_RES` now also covers the adverb forms („are not actually available", „are actually not available", „aren't actually available"), the bare „not available in this / here / in my …" wording, refusals that name the tools one by one (`read_file` / `write_file` / `list_files` / `edit_file` / `run_npm` … not available) and the Romanian „instrumentele … nu sunt **de fapt** disponibile"; the one-shot `TOOL_REFUSAL_NUDGE` is sent instead of posting the refusal as the final answer.
- FIX (bug #44): **the AI selector finder timed out before it could analyze the DOM.** The 45 s budget was not enough for the ~19k-character snapshot on a local 7B model („analiza AI a eșuat: timeout after 45s"). The default `freekit.aiFinderTimeoutSeconds` is now **120 s** (still 5–300 s).
- FIX (bug #44): **a failed AI analysis left a stale locally learned selector in front of the static one.** When the AI finder produces nothing for a slot (timeout, unparsable answer, selector rejected at validation), the learned override with `how='ai' | 'fingerprint'` for that provider+slot is now forgotten (and removed from `selectors-user.json`), so reading falls back to the selector from `selectors.json` — the stale „repaired" chain (e.g. `div.xh8yej3.x1ghz6dp` at ChatGPT) can no longer shadow it. Selectors published by the reporting server (`how='server'`) are kept. A losing request after a timeout can no longer surface as an unhandled rejection in the extension host.
- FIX (bug #47): **the ChatGPT response selector list contained a chain that could never match.** Verified live on chatgpt.com (CDP, port 9222): the turn container is a `<section data-testid='conversation-turn-N'>`, not an `<article>`, so `article[data-testid^='conversation-turn'] .markdown` matched 0 elements and is replaced by the tag-agnostic `[data-testid^='conversation-turn'] .markdown`; the primary `[data-message-author-role='assistant']` (2/2 turns) and the `.markdown` alternative (2/2) were re-validated on a real conversation. Selector config bumped to v1.5.3 (`model-response` is a Gemini-only element — re-checked live there, `model-response .markdown` still matches on a real Gemini chat).
- Version bump to 2.5.17.

## v2.5.16

- FIX (bug #43): **tool-protocol refusals in new wordings were accepted as final answers.** The v2.5.14 detection missed formulations like EN „the tools you specified are not available in this session" / „I can't access the workspace" / „not available in my current environment" and RO „Nu pot executa modificarea în workspace-ul VS Code din această conversație: instrumentele read_file / edit_file / run_npm / git_* pe care le-ai specificat nu sunt disponibile în mediul meu actual." / „Nu am acces la fișiere" / „Nu pot citi fișiere". `looksLikeToolRefusal` now checks a list of EN/RO patterns (`TOOL_REFUSAL_RES`) covering tools/connectors unavailable, missing workspace/project/file access, „cannot execute/modify/edit", „don't have the ability/tools", and the Romanian equivalents; detection still gets the one-shot `TOOL_REFUSAL_NUDGE` instead of posting the refusal as the answer.
- Version bump to 2.5.16.

## v2.5.15

- FIX (bug #41): **ChatGPT free „Chat memory full" was not detected — the agentic loop kept sending nudges into a chat that could not answer any more** (live-reported after 5-10 tool calls on the ~8k-token free context: banner „Chat memory full — continue in a new chat", no reply, loop running to timeout). The banner text („chat memory full" / „continue in a new chat" / „memory limit reached") is now recognized both on the response text and in the page scan (`memory_full` kind in `src/providerErrors.ts`), so the wait stops at detection instead of a silent 150 s timeout.
- FIX (bug #41): **the detected context limit now offers a way to continue** — a card with **💬 New chat & continue** / **🌐 Show Browser** / **⏹ Stop**. „New chat & continue" opens a fresh browser chat, re-sends the pending step prefixed with a compact handoff (original task + recent steps from the conversation history, size-capped so the new chat does not fill up immediately) and resumes the agentic loop there (sentinels, checkpoints and the wait budget are reset; max 3 restarts per message). „Stop" clears the remembered browser chat, so the next message starts a new chat automatically.
- Version bump to 2.5.15.

## v2.5.14

- FIX (bug #39): **ChatGPT sent truncated messages and polluted the next one.** Live-proven: on chatgpt.com an isolated `insertText('\n')` in the composer acts as Enter, and `humanType` typed the natural head (30-50 chars) straight across the first line break - so the message was submitted at the first newline, the rest stayed in the composer as a **draft** and got prepended to the next message (the 771-char retry nudge arrived as only its 38-char first line; the following nudge was sent as leftover + full nudge, so the model saw garbled instructions). The natural head now stops **before the first `\r`/`\n`** and the whole remainder is pasted in one `insertText`.
- FIX (bug #39): **composer verified before Enter** - before typing, any leftover draft is cleared (it used to be glued to the next message, e.g. "SYSTEM NOTICE" leftovers prepended to the next nudge); after typing, the composer content is compared with the intended message, and on mismatch the whole message is re-pasted in one shot (`clearComposer` / `ensureComposerHasMessage` in `src/providers/base.ts`).
- FIX (bug #38): **login was detected too early after sign-in.** `waitForLoginIndicator` broke out of its poll loop as soon as the "Log in" indicator was absent - which is also true while the post-login page is still transitioning (header/composer not rendered yet). The message was then sent ~4 s after the indicator vanished, while ChatGPT was still serving the old (guest) session, and the model answered "the VS Code workspace tools you specified are not available in this session". Login is now confirmed only after `LOGIN_CONFIRM_POLLS` (2) consecutive clean polls with the composer rendered (`isSessionReady`); `waitForLogin` got the same consecutive-poll requirement.
- FIX (bug #38): **a tool-protocol refusal is retried, not accepted as the final answer** - a short reply like "the tools ... are not available" / "I can't access the workspace" is detected by `looksLikeToolRefusal` and gets one explicit nudge (`TOOL_REFUSAL_NUDGE`: the tools are executed by the VS Code client), instead of being posted as the answer.
- FIX (bug #39): **malformed tool-call replies get the marker-format nudge first** - a reply that is a tool-call attempt which cannot be parsed (one-line JSON with raw quotes) skips the "reply with a single-line JSON object" nudge (which repeated the exact format that had just failed) and is asked directly for the marker format.

## v2.5.13

- FIX (bug #37): **Gemini returned the sidebar „Recents” list instead of the AI reply.** Right after a message is sent the reply element (`model-response`) is still absent from the DOM — measured live: ~1.5–3 s for a short prompt, well over 4 s for the ~8 KB agentic system prompt — while the conversation list is already rendered. At the first heal checkpoint (4 s) `healSlot` found no valid reply candidate and learned the sidebar block instead (`div.chat-history-list.ng-star-inserted`, score 8.34 = `tag:div, depth:4` — no content signal at all), persisted it in `globalState`; `candidates()` unshifts learned overrides, so `readLastText` returned that element's text (1311–1330 chars of chat titles) as the „stable” answer, and the count-based sentinel of bug #36 (sidebar appearing after `beforeCount=0`) then accepted it as a new response.
- Reader: `readLastText`, `countLastResponses` and `anySelectorMatches` now skip **navigation zones** (`nav`, `aside`, `[role="navigation"]`, `[role="complementary"]`, `bard-sidenav`, `side-navigation-content`, `.chat-history-list`) — a stale override can no longer hijack the answer, a match inside the sidebar no longer counts as „the response selectors work” (which used to mask the breakage), and the generic fallback stops picking sidebar blocks; `readLastText` and `countLastResponses` stay consistent for the bug #36 sentinel.
- Healer: `scanCandidates` rejects navigation zones for the `response` slot (deliberately *not* for `newChat`/`stopButton` — Gemini's „New chat” button legitimately lives in the sidebar) and now requires a **content signal** for a reply candidate: an element with no `p`/`ol`/`ul`/`pre`/`code` child (exactly what every provider's `fingerprint.hasChildren` declares) is refused, because chrome blocks used to win the scan on `tag`+`depth`+`position` alone. It also refuses a candidate whose text is exactly the message we just sent, so the user's own bubble can no longer be learned as „the reply”. Net effect: on a page where the answer has not rendered yet the healer learns **nothing** and simply waits (verified live on an empty chat and on the full send timeline: 4 s checkpoint → no repair → real reply read afterwards).
- Persistence: the same tokens (`chat-history`, `suggestion`, `sidenav`, `side-nav`, `zero-state`) were added to the attribute blacklist, so such selectors are refused when learning *and* already-saved ones are purged automatically on activation (`init()`) — existing installs (including the poisoned `gemini.response` override reproduced in the report) self-heal without a manual „Reset Repaired Selectors”.

## v2.5.12

- FIX (bug #36): **the agentic loop froze at „Pasul 1/40" when the AI repeated its previous answer verbatim** — typically the same tool call again after a `TOOL_ERROR` (e.g. `read_file` for a file that does not exist). `sendAndWait` used the text of the last response captured *before* sending as its „a new response appeared" sentinel; when the new reply was identical to the previous one, that comparison stayed true forever, so the loop spun until the 150 s hard timeout and the follow-up reply was never parsed or executed. The sentinel is now the **number of response bubbles present in the DOM** (`countAssistantResponses`): any new bubble counts, regardless of its content. The redundant identical-text guards in the streaming loop and in the RESCUE path were updated accordingly.
- FIX (bug #26 + #32): translated remaining Romanian UI strings to English (e.g. 'Pasul X/40' → 'Step X of 40'). Consistent language across the interface. The step line now reads „Step X of 40: <tool>" and its hover tooltip says „Agentic loop iteration X of 40 max", so it is clear that X is the agentic-loop iteration, not an attempt counter. Also translated the other user-visible leftovers found in the audit: Whisper/STT setup and transcription errors, voice-capture errors, Show/Hide Chrome notices, MCP server errors and dev-server notes.
- FIX (bug #35): **ChatGPT without an account went undetected** — guest mode keeps a functional composer, so `findInput()` succeeded and the login check (which only ran on the „input missing" branch) never fired; the guest answer came back as a normal response (no account, no history, tighter limits). Freekit now detects the visible **„Log in" / „Sign up for free"** CTAs through a new `loggedOut` selector slot (validated live against the logged-out page; `selectors.json` → **v1.5.2**) and **asks instead of blocking** — a card with **🌐 Show Browser / 💬 Continue as guest / ⏹ Cancel**. „Continue as guest" is remembered per session (no repeated questions) and guest mode stays fully usable; „Show Browser" brings the Chrome window forward and waits until the logged-out indicator disappears (`runWithLoginAssist` polled only the URL, which never changes on chatgpt.com, so login could never be confirmed). Other providers are unaffected (no `loggedOut` slot → no detection).

## v2.5.11

- FIX (bug #21): **„Show Chrome" and „Open Browser" were two buttons that did almost the same thing**, which confused users — „Show Chrome" brought the window to the front, while „Open Browser" started/reconnected Chrome but then left it minimized and without a taskbar button (`applyHiddenState`), so the user saw only the „Connected to Chrome" toast and never found the window. The two are now a single **„Show Browser"** button (menu ⋯ → Context, 🌐 globe icon) that launches Chrome when needed *and* brings the window on screen and focuses it.
- The `⋯` menu entry „Open Browser" was removed; the login-required and provider-error cards and every in-chat hint now say „Show Browser".
- The `freekit.openBrowser` command is kept as a **hidden alias** (back-compat) — it is no longer listed in the Command Palette and now runs the same `show()` flow; `freekit.showChrome` is listed as `Freekit: Show Browser`.
- Cleanup: removed the unused `ICONS.showChrome` sprite and the dead `open_browser` webview message.
- FIX (bug #24): **the model chip advertised an Ollama model that was not installed.** When `/api/tags` returned nothing (server stopped, or `ollama list` empty), the menu fell back to the `freekit.ollamaModel` setting and rendered it as if it were installed — active checkmark, blue dot, no size — so the chip showed e.g. `qwen2.5-coder:7b` on a machine that had never pulled it. The list is now strictly the live `/api/tags` result; when Ollama cannot serve anything, an informational `Ollama (local)` row explains why (`not running` / `no models installed` / `"X" is not installed`) and the chip stops claiming a model. With an empty list the menu also offers starter downloads (`qwen2.5-coder:7b`, `llama3.2`, `nomic-embed-text`), and the configured-but-missing model always keeps a download row — previously the fabricated entry poisoned the "installed" set and hid that very row.
- FIX (bug #25): **the missing Ollama model produced a raw `Ollama error: 404 Not Found — model "…" not found, try pulling it first`** pasted into the chat as the assistant message. `OllamaProvider.open()` now validates the configured model against the freshly fetched list and throws a typed `DetectedProviderError` (`kind: 'model_missing'`, plus the installed models), and the 404 in `send()` is converted the same way instead of surfacing as a plain `Error`. The webview renders a dedicated card — **⚠️ Ollama — model not installed**, with the installed models listed and buttons **📥 Download "X"** (reuses the existing `pull_model` flow) and **Switch to another model**. In the Auto chain a typed provider error is no longer swallowed into the generic „Auto: all failed" message, so the card is shown there too.
- `OllamaProvider.listModels()` now uses the same 5 s timeout as `listOllamaModelsDetailed()`, so an unresponsive server cannot stall the error path.
- FIX (bug #27): **double approval** — the in-chat review card and the VS Code notification (Accept / Reject) were shown *at the same time*, so approving in the chat left the notification buttons on screen and it looked like a second confirmation was required. The chat card is now the single decision surface; the notification is shown **only** when the card cannot be delivered to the webview (no webview, or `postMessage` returns `false`). The „You can also decide from the VS Code notification" hint and the notice advertising both paths are gone.
- FIX (bug #28): **too-small local models were advertised as „recommended"** (that label only meant „it fits in memory"). The model menu now uses the catalog quality rating: under 3B or quality < 45 gets „⚠️ 1.5B — too small for real code; 7B+ recommended", 7B+ models get „7B+ best", and embeddings-only models (nomic-embed-text & co.) are marked „⛔ embeddings only — not a chat model". Selecting a weak model shows a one-time warning with a „Pick bigger model" button, downloading one no longer auto-selects an embeddings model, and every row (installed and downloadable) shows both the parameter count and the size (`7B · 4.8 GB`). `nomic-embed-text` was removed from the starter list.
- FIX (bug #29): **no warning about local inference load on weak machines.** The model menu now shows a visible note (not just the hover tooltip) on T0/T1 machines or when VRAM is 0: local models run on CPU/RAM (heavy load, fan, shorter battery) and the free web providers are the lighter alternative; selecting Ollama on such a machine posts the same advice with a „Switch to web provider" button, and the provider status report mentions it too.
- FIX (bug #34): selector health check no longer reports false `not_found` when Chrome happens to be on a non-chat page of the same host (Gemini landing, `/share/…`, error page). It now verifies the URL is the app page (host **and** path, not just the host — `isAppPage`), navigates to the app URL when the tab is elsewhere, waits up to 5 s for the SPA to render, and — when no critical slot exists in the DOM at all — reports a single `wrong_page` instead of two `not_found` entries (no DOM snapshot is attached to it). Gemini selector hygiene: removed the dead `textarea` / `button[aria-label*=…]` candidates (the „New chat” element is an `<a>`), added stable `role` / `aria` / `data-*` alternatives (verified live); `selectors.json` bumped to **v1.5.1**.
- FIX (bug #33): **circuit breaker** — the agentic loop stops after 3 consecutive failures of the same tool, with a clear error message (tool name, last error, suggestions). Prevents 40-iteration loops when a tool keeps failing (e.g. Ollama on slow hardware, bad paths, permission errors). Successful runs of a different tool reset the counter.

## v2.5.10

- FIX (bug #20): **a new web chat was opened for EVERY message**, at all providers (DeepSeek, Claude, Gemini, ChatGPT, Mistral, Qwen) — the AI lost the whole context and the site's sidebar filled up with conversations. The root cause: `chatView.handleMessage` called `open()` + `newChat()` unconditionally before each message, and the conversation URL was never remembered. Now the browser conversation is stored per VS Code conversation (globalState, `Conversation.browser = { providerId, url }`): the first message still opens a new chat, but every following message resumes the saved URL (`resumeConversation`), and the chat is re-opened only when the conversation is new, the saved chat can no longer be loaded, or the user runs Clear / Edit prompt / Restore checkpoint (the VS Code history was cut, so the browser must start fresh too). Retry and provider Switch reuse the same chat instead of creating another one.
- `newChatVia` no longer clicks several "New chat" candidates in one run: once the URL changes, the click is treated as successful (no more empty conversations left in the site's sidebar).

## v2.5.9

- Fix: busy indicator (3 animated dots) remained visible after direct write. The webview 'busy' handler now clears the pending element when busy turns off, so the indicator disappears immediately after 'Direct write' completes.

## v2.5.7.1

- FIX (bug #13b): **direct write detection never fired** when the code block in the prompt has no closing fence — the final fence is forgotten or gets lost when the prompt is pasted. The prompt that reproduced it (`Creează fișierul src/layouts/BaseLayout.astro cu EXACT acest conținut:`, followed by an open Astro block) arrived exactly like that, so v2.5.7 always fell back to the AI. Direct write mode now also accepts a single **open** fence: everything after it is the file content.
- Whitespace between the opening fence and the language label is tolerated now, and the closing fence may be indented.
- A code block with no content is no longer written as an empty file — the request goes to the AI instead.
- Prompts the previous version already detected behave identically: closed block, inline fence, quoted / Windows paths, text after the block. Two or more blocks are still left to the AI.

## v2.5.7

- MAJOR: Direct write mode. When the user provides exact content via code fence with "EXACT"/"cu exact acest conținut", Freekit writes the file DIRECTLY from the prompt, bypassing the AI. Zero improvisation, zero truncation, zero UI artifacts. Fixes the root cause of bugs #8, #10, #11 for prompts with exact content.

## v2.5.6

- FIX (bug #11): **truncation guard**. Content that arrives incomplete — an Astro/HTML document without its `</html>`, unbalanced braces in `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.css`, or an unterminated JSON object/array — is no longer written silently. The write is refused, the model gets a nudge to rewrite the COMPLETE file (max 2 retries), and once the retries are exhausted the chat shows a clear warning (the AI may have hit a length limit: try a smaller file, a different provider, or split it into multiple files). Applies to `write_file` and to `write_files` (one incomplete file rejects the whole batch); the check runs before the approval card, so no diff is proposed for a file that will not be written. Astro pages/components that use a layout do not contain `<html>` and are still treated as valid.
- A successful write resets the truncation counter for that file; the counters reset per message together with the anti-spam write limits.
- FIX (bug #10): **divergence warning**. The content the model writes is compared with the code block(s) from the user's last message (`extractCodeFences` + `contentSimilarity`, Jaccard on normalized lines). When the written content both looks unlike the relevant block *and* is missing a meaningful part of the requested lines, the file is marked `divergent`. **WARNING ONLY** — nothing is blocked and there is no automatic retry (a retry can improvise just as well): the warning appears under the diff in chat (small, yellow/orange) in all three card shapes — inline file row, inline review card, and the fallback approval card — and after an auto-approved write the chat posts a notice listing the affected files. Line normalization ignores trailing `,`/`;` and the "requested lines" test is weighted by line length, so a config that merely shares Tailwind's scaffolding (`theme: {`, `colors: {`) is not mistaken for the requested one, while a full file legitimately built from a prompt fragment is not flagged.
- The comparison only runs when the block can be tied to the file being written (the block names the file, follows its mention in the prompt, or the prompt names no file at all and has a single block) — a prompt with one block describing file A no longer warns about every other file B.

## v2.5.5

- CRITICAL FIX (bug #8b): the UI-artifact stripper no longer misses the header when the extracted content starts with a leading newline/space/BOM (code block whose first line is empty). Leading whitespace is ignored when looking for the `astro`/`Copy`/`Download` header, artifacts are removed in up to 5 passes, and the header regex now tolerates spaces around the lines and extra language labels (`js`, `ts`, `jsx`, `tsx`, `sh`).
- Real indentation of the first content line is preserved when no UI artifact follows, so `edit_file`/`write_file` content is not altered.

## v2.5.4

- CRITICAL FIX: strip UI artifacts (astro/Copy/Download header) that DeepSeek and other providers inject at the start of code block content. Without this, files written via DeepSeek were corrupted with extra header lines.

## v2.5.3

- Fix DeepSeek echo bug (prompt echoed at start of reply). Strip echoed user message before parsing. Normalize literal \n in content. Auto-retry on malformed tool call.

## v2.5.2

- CRITICAL FIX: content of write_file/edit_file is now wrapped in a markdown code fence to prevent markdown rendering from corrupting # and * characters (e.g. # Heading, **bold**, CSS hex colors like #ff0000).
- Parser strips the wrapping fence if it survives extraction.
- 'Switch provider' button in provider-error card now opens the real model menu (removed hardcoded DeepSeek).

## v2.5.1

- Detect provider errors (out of messages, login, rate limit, CAPTCHA) with clear in-chat card.
- Action buttons: Show Chrome / Retry / Switch provider / Upgrade.

## v2.5.0

- **CRITICAL FIX**: auto-verify no longer blocks new project scaffolding. Skips when `node_modules` missing, `src/` empty, or no verified-good state. Runs once per AI response, not per file write.
- **Safe rollback**: only rolls back if verified-good state ever existed.
- **UI**: clear leftover verbose steps after rollback.
- **UX**: clearer error message when auto-verify fails definitively.

## 2.4.9 — 2026-10-05

**CRITICAL FIX: marker-based format for `write_file` / `edit_file` / `write_files`** — a `content` holding *unescaped* quotes is ambiguous JSON by definition (`{"tool":"write_file","args":{"content":"{"name":"x"}"}}` — nothing can tell where the string ends), so no parser can repair it; every model that produced it (DeepSeek, Claude, ChatGPT) ended in "malformed tool call". The three tools that carry free-form content no longer use JSON: the model writes the content **raw** between markers, and the parser reads it verbatim. All the other tools keep the JSON format.

- **`src/toolCallParser.ts`** — new `parseMarkerToolCall()`. It finds the `TOOL:` line (case-insensitive, leading whitespace ignored) and, for the tools above, reads the raw text between markers that each sit alone on their line. `write_file`: `PATH:` + `CONTENT:` … `END_CONTENT`; `edit_file`: `PATH:` + `OLD_TEXT:` … `END_OLD_TEXT` + `NEW_TEXT:` … `END_NEW_TEXT`; `write_files`: repeated `PATH:` / `CONTENT:` / `END_CONTENT` blocks separated by `---FILE---` (the separator is optional and surrounding prose is ignored). The content is verbatim — newlines, quotes, braces, backslashes and emoji are kept exactly as written; the newline just before the closing marker is not part of the content, while a deliberately empty line is. A missing or unterminated marker, an empty path, or any other tool returns `null` — no crash, no guessing.
- **Priority + fallback** — `parseToolCallText()` now tries the marker format first and falls back to the v2.4.8 JSON extractor (balanced braces, fences, tolerant quote/control-character repairs) only when there is no valid marker block, so models that still reply with JSON keep working. `looksLikeToolCallAttempt()` also recognizes a `TOOL:` marker block for a content tool, so an unterminated one surfaces the clear *"Model returned malformed tool call. Try again or switch provider."* error instead of dumping the raw text as the final answer.
- **`src/tools.ts`** — the `SYSTEM_PROMPT` gained a **WRITING FILES — MARKER FORMAT (MANDATORY)** section with the exact shape of the three tools and the rule that the content between markers is RAW (never escaped, never truncated, never JSON-quoted); the workflow examples were rewritten in marker form and the strict rules updated (JSON tool calls stay single-line and unfenced, the write markers are multi-line; "ONE tool call per message, on a SINGLE LINE" no longer contradicts the format).
- **`src/chatView.ts`** — a concrete *"Example — creating a file"* marker block is appended to the prompt of the browser providers (right after the system prompt), next to where the parser is used. Local (Ollama) providers keep their existing JSON-only prompt.
- **Docs** — version bumped to 2.4.9 in `package.json` / `package-lock.json`, and the README badge and Development snippet follow.

## 2.4.8 — 2026-10-05

**The tool-call parser survives real model output** — a reply whose `content` holds nested braces and escaped quotes no longer ends in *"NO TOOL CALL DETECTED"* followed by two useless auto-retries; the tool call is now found inside whatever text surrounds it.

- **`src/toolCallParser.ts`** (new) — replaces the old `parseToolCall` in `chatView.ts`. The old parser first demanded that the *whole* reply be a single JSON object (`!clean.startsWith('{') || !clean.endsWith('}')` → `null`), so any prose or a fence around the JSON meant "no tool call", and its recovery regex `/\{\s*"tool"\s*:[\s\S]*\}/` was greedy at the wrong end. The extractor now scans once, string- and escape-aware, and collects candidates in order: the body of every fenced code block, every **balanced** `{…}` that opens with the `"tool"` key (so nested braces inside `content` and the trailing `}}` no longer break it — spaces and `{'tool':` variants included), the last balanced object in the text, then the whole reply with a leading fence stripped. Each candidate goes through `JSON.parse` and then through two tolerant repairs: real control characters (newline / CR / TAB, which web providers leave unescaped inside `content`) are escaped, and unescaped quotes inside values are re-escaped, keeping the existing quote heuristic but without its `slice().match()` per quote.
- **Clear error instead of raw JSON** — when the reply is plainly a tool-call attempt (starts with `{"tool":`, fence or not) that still cannot be parsed after the two auto-retries, the chat now shows **"Model returned malformed tool call. Try again or switch provider."** and records it in the conversation instead of posting the broken JSON as the final answer.
- **`src/chatView.ts`** — `parseToolCall` delegates to the new module; the now-dead `normalizeToolCall` / `repairJsonQuotes` private methods are removed. Behaviour of the agentic loop (retry policy, step limit, auto-verify) is unchanged.
- **Docs** — version bumped to 2.4.8 in `package.json` / `package-lock.json`, and the README badge and Development snippet follow.

## 2.4.7 — 2026-10-05

**Block isometric icon** — the trident is replaced by the Block isometric 3D mark, split into a coloured PNG for the Marketplace listing and a flat silhouette for the Activity Bar.

- **`media/icon.svg`** (replaced) — the Activity Bar icon is now the flat **F** silhouette (`viewBox="0 0 128 128"`, `fill="currentColor"`), built from the front face of the Block mark. VS Code masks Activity Bar icons by alpha, so the SVG colours would be thrown away anyway; the old 16x16 trident path is gone.
- **`media/icon.png`** (replaced) — the coloured Block mark (green top face, violet side faces, red **F** front face), 128x128 on a transparent background, declared by `"icon"` as the Marketplace listing icon.
- **`package.json` / `package-lock.json`** — version bumped to 2.4.7; the lock file also picks up the `"license": "SEE LICENSE IN LICENSE.txt"` field introduced in 2.4.6.
- **README** — version badge and the Development snippet now reference 2.4.7.

## 2.4.6 — 2026-10-04

**Legal protection and donations** — the license is now an explicit proprietary EULA, and the project accepts donations through Buy Me a Coffee.

- **`LICENSE.txt`** (new) — proprietary license replacing `LICENSE`: ownership, permitted use, restrictions (no copying, modification, redistribution or reverse engineering), a third-party-services disclaimer, termination, no-warranty and limitation-of-liability clauses. The copyright holder is now **Laurentiu Pelin / Builderweb** (previously "Lanon").
- **`package.json`** — added `"license": "SEE LICENSE IN LICENSE.txt"` and a `"sponsor"` entry pointing at <https://buymeacoffee.com/builderweb> (renders a Sponsor link on the Marketplace page); the `repository` block is re-indented to valid two-space JSON.
- **README** — new **Support** section with a Buy Me a Coffee badge, the footer links the donation page, the license link points at `LICENSE.txt`, and the Development snippet drops the now-unneeded `--allow-missing-repository` flag.

## 2.4.5 — 2026-10-04

**Packaging fixed** — vsce refused to build with *"Couldn't detect the repository"*, because `package.json` declared no `repository`; with no repository it cannot resolve the relative screenshot paths in the README into absolute URLs, so `freekit-2.4.4.vsix` was never produced. The manifest now declares the Git repository and the package builds again.

- **`repository` added** — `package.json` declares `{"type": "git", "url": "https://github.com/builderweb/freekit"}`, placed right after `publisher`, so vsce can detect the repo and rewrite relative README links.
- **README encoding verified** — `README.md` is UTF-8 **without BOM** (20193 bytes, strict-UTF-8 valid); emoji are intact (✅ ❌ ⚠️) and no mojibake (`âœ…` / `âŒ` / `âš`) remains.
- **Docs** — the README version badge and the Development snippet now reference 2.4.5.

## 2.4.4 — 2026-10-04

**Marketplace-ready README** — the README is rewritten for the VS Code Marketplace listing, with screenshots first, a comparison table, and a structure built for first-time visitors. No source code changes.

- **New structure** — header + tagline + two badges → screenshots → *Why Freekit?* → organized features → quick start → supported providers → how it works → privacy → trust / Restricted Mode → commands → settings → advanced deep-dives → troubleshooting → requirements → license.
- **Screenshots up front** — all six `media/screenshots/*.jpg` images (chat, model selector, hardware tiers, native diff, sessions menu, reporting dashboard) are embedded at the top of the listing.
- **Why Freekit? table** — side-by-side comparison against Cline, Cursor and Copilot on provider support, cost, local Ollama, free-account support, self-maintenance and native diff.
- **Providers corrected** — six web providers (DeepSeek, ChatGPT, Claude, Gemini, Mistral, Qwen) plus local Ollama; Kimi is no longer mentioned anywhere (removed in 2.4.2).
- **Features consolidated** — the long feature dump is replaced by scannable bullets that also surface auto-verify/rollback, dev servers in a visible terminal and verbose mode.
- **Preserved verbatim** — the full **Commands** (19) and **Settings** (36) tables are unchanged; the semantic-search, remote-selector, reporting-server and MCP write-ups move into an **Advanced** section.
- **New sections** — *Trust / Restricted Mode* spells out what still works in an untrusted folder, and *Troubleshooting* covers the four most common failures.
- **License & footer** — proprietary license now linked to the real `LICENSE` file, with a `builderweb` footer; the Development snippet points at `freekit-2.4.4.vsix`.

## 2.4.3 — 2026-10-04

**The input box shows it is working** — while the AI is generating, the composer border runs an animated conic gradient, so a long answer no longer feels like the chat is frozen.

- **Animated border** — `.box.busy` hides the normal border and paints a rotating conic gradient ring with a masked `::before` overlay, driven by a registered `@property --angle` (2 s linear loop) in `media/chat.css`.
- **Fallback** — browsers without `conic-gradient(from var(--angle), …)` support get a simple border pulse instead.
- **Wiring** — `setBusy()` in `media/chat.js` toggles the `busy` class on `.box`, so every path that enters/leaves the generating state (send, stop, `busy` message from the extension, errors) drives the effect consistently.

## 2.4.2 — 2026-10-04

**The Kimi provider is removed** — Kimi migrated from `kimi.com` (China mainland) to `kimi.ai` (international), and the bundled selectors written for `kimi.com` no longer work on the new site. With no `kimi.ai` account available to re-verify and repair them, the provider is dropped until it can be tested against the live site. The other providers are untouched.

- **Provider lists** — `kimi` removed from `PROVIDER_IDS`, `PROVIDER_LABELS` and `BROWSER_PROVIDER_IDS`, and the `createProvider()` switch (`src/providers/index.ts`).
- **Model selection** — Kimi removed from the curated model catalog and the model-menu selectors (`src/modelSelector.ts`), and from the per-provider thinking selectors (`src/providers/base.ts`).
- **Provider file** — `src/providers/kimi.ts` deleted.
- **Bundled selectors** — the `kimi` entry removed from `src/selectors.json`; the config version is bumped (1.4.0 → 1.5.0) so a cached/remote config that still carries Kimi is ignored.
- **Manifest & docs** — `kimi` removed from the `freekit.provider` enum and the keywords, and Kimi dropped from the README provider lists.

## 2.4.1 — 2026-10-04

**Restricted Mode is no longer silent** — the extension now activates in untrusted folders with reduced (read-only) functionality instead of doing nothing, and tells the user exactly what to do. `capabilities.untrustedWorkspaces` changed from `false` to `"limited"`; non-technical users who never noticed the VS Code trust banner now get an unmissable notification with a **Trust Workspace** button, plus a persistent card in the chat.

### Trust UX (`src/trust.ts`, new)

- **Activation notification** — on startup in an untrusted folder, a warning notification appears with **Trust Workspace** (opens VS Code's *Manage Workspace Trust* page via the stable `workbench.trust.manage` command — one click on **Trust** there grants trust) and **Learn More** (VS Code Workspace Trust docs). It is shown once per session, and re-shown (max once every 20 s) when the AI actually tries a blocked action.
- **Persistent chat card** — opening the Freekit view in Restricted Mode posts the same guidance into the chat, so it survives dismissing the notification.
- **`Freekit: Trust This Workspace`** — new Command Palette command (also the target of the notification button).

### Graceful degradation

- **Read-only tools keep working** — `read_file`, `list_files`, `search_files`, `read_files`, `project_info`, `search_semantic` and `git status/diff/log` remain available, so the chat can still answer questions about the code.
- **Blocked without Trust** — `write_file`, `edit_file`, `write_files`, `run_command`, `run_npm`, git actions that change state (`commit` / `branch` / `revert` / `restore`), all MCP tools and file checkpoints/restore return a clear error instead of failing silently or half-running.
- **No more total block** — the chat no longer refuses every message in Restricted Mode (it previously returned an error and stopped); the agent runs, reports the restriction to the model, the model relays it to the user, and the Trust notification is surfaced at that moment.
- **Reporting and MCP are deferred** — the reporting server integration and MCP server processes do not start until the folder is trusted; `onDidGrantWorkspaceTrust` enables them live and confirms it in the chat (no reload needed when VS Code grants trust in place).
- **Diagnostics** — the workspace-trust line now reads `RESTRICTED (read-only: file writes, commands and MCP tools are disabled)`.

## 2.4.0 — 2026-10-03

**The selectors now maintain themselves** — beyond the local healer and the Gist, the extension talks to the Freekit reporting server: it reports a selector that it could not repair locally, and it receives the repairs other clients reported. A site redesign found on one machine becomes a fix for everyone, without an extension release.

### Reporting client (`src/reporting.ts`, new)

- **`ReportingClient`** — anonymous registration (`POST /api/v1/extensions/register`) with a random `installationId` kept in globalState, exchanged once for an `apiKey` (idempotent; the key is re-used until reset), best-effort `report()` (`POST /api/v1/reports`, `x-freekit-key` header) and `fetchUpdatedSelectors()` (`GET /api/v1/selectors?since=<revision>`), with a `304` handled as "up to date". Every call has a 10 s timeout and never throws — the extension behaves exactly as before when the server is unreachable.
- **Health check** — for each provider that already has a tab open in the Freekit Chrome profile, `input` and `newChat` are verified; a missing slot is repaired **locally first** (fingerprint healer → AI finder) and only reported when that also fails, with `failureType` `not_found` (absent) or `hidden` (present but invisible). Chrome is never started just to run the check, and a wrong tab is never probed.
- **Server selectors are applied** — the list returned by `/api/v1/selectors` is mapped to providers by domain (protocol/port/path/`www`-insensitive) and passed through the normal `selectors.learn()` validation, so fragile, blacklisted and UI-chrome selectors are rejected exactly as they are for local repairs. A new `server` value on `LearnHow` records their origin.
- **`ReportingService`** — schedules registration at startup, the health check every 6 h and the selector fetch every 24 h, with timers disposed with the extension; new selectors are announced in the chat.

### Settings & commands

- **`freekit.reporting.enabled`** (master switch), **`freekit.reporting.endpoint`**, **`freekit.reporting.shareDomSnapshot`** (off by default — sends a cleaned DOM snapshot with a report), **`freekit.reporting.healthCheck`**, **`freekit.reporting.healthCheckIntervalHours`** (6) and **`freekit.reporting.selectorsIntervalHours`** (24).
- **`Freekit: Reporting Status`** (state + run/reset shortcuts), **`Freekit: Run Selector Health Check`** (run now, e.g. right after a redesign) and **`Freekit: Reset Reporting Registration`** (new identity).

## 2.3.1 — 2026-10-02

**The dropdown menus are as wide as the chat** — the model and thinking menus no longer lock to a fixed 210/240 px width. They stretch across the whole composer row, so long model names ellipsize on a single line instead of wrapping onto two.

### Menus (`media/chat.css`, `media/chat.js`, `src/chatView.ts`)

- **Full-width "up" menus** — `.menu.up` is now positioned against the composer's chip row instead of the chip itself: `.composer .ctx` is the containing block and its `.pop` wrappers are made `position: static`, so `left: 0; right: 0; width: auto` spans the entire row and the menu still opens exactly under the chip that triggered it. The `.composer` prefix matters because `.ctx` is also used by the context menu (`.menu.ctx { position: fixed }`).
- **The header `⋯` menu keeps its own rules** — it stays right-aligned to its button, with `min-width: min(240px, calc(100vw - 24px))` and `max-width: min(320px, calc(100vw - 24px))`, so a window narrower than the menu degrades instead of pushing a horizontal scrollbar.
- **No more two-line model names** — `.mi` is `white-space: nowrap; overflow: hidden` and `.mi .lbl` gets `flex: 1; min-width: 0` with `text-overflow: ellipsis`, while `.mi .sub` is `flex-shrink: 0` so the badge stays pinned to the right. This also subsumes the old `#conv-list .mi .lbl` rule, which only did this for the conversation rows.
- **Tooltip with the full name** — `syncOverflowTitles()` sets `title` only on elements that are genuinely clipped (`scrollWidth > clientWidth`). It runs when a menu opens (so keyboard users get it too), after the model menu re-renders, and lazily on hover/focus, which keeps it correct across sidebar resizes and label rewrites. It never overwrites an intentional title: conversation rows keep their `title (N messages) — right-click to delete`, the chips keep `Provider and model`, and attachment/message chips are out of scope (`.chip` is used there too, so the selector is `.menu .mi, .composer .ctx .chip`).
- **`min-width: 0` + viewport-aware `max-width`** — the menu shrinks with the sidebar instead of forcing a horizontal scrollbar. `max-height: 60vh` and `overflow-y: auto` are unchanged, so long provider lists still scroll.
- **Removed the inline `style="min-width:200px"`** from `#menuThink`, which would otherwise have overridden the responsive width.

## 2.2.0 — 2026-10-02

**The model chip actually switches models** — picking a model for a web provider now drives the site's own model dropdown through Chrome, so the next message is answered by the model you chose (v2.1.0 only changed the label).

### Model selection (`src/modelSelector.ts`, new)

- **`applyModel(page, providerId, modelId)`** — checks whether the model is already active (no useless click), opens the provider's model menu, finds the option, clicks it and verifies the new label; returns `false` (leaving the page clean) when a site redesign breaks the menu.
- **`getAvailableModels(page, providerId)`** — reads the real options from the open dropdown and merges them with the bundled catalog, so a model that just appeared on the site shows up without an extension update; falls back to the catalog whenever the menu cannot be read.
- **`readCurrentModel` + normalized matching** — case/diacritics/punctuation-insensitive scoring: exact (1000) > name + qualifier (700) > whole token (500) > substring (below the acceptance threshold). A prefix that adds a **variant token** (`mini`, `pro`, `thinking`, `o3`…) is rejected, so `GPT-4o` never steals the click meant for `GPT-4o mini` and `o3` never lands on `o3-mini`, while a family name still matches a newer release (`Sonnet` → `Sonnet 4.5`). Options marked `disabled` / `aria-disabled` are skipped.
- **Curated catalog per provider** — ChatGPT (GPT-4o / 4.1 / 4.1 mini / o3 / o4-mini), Claude (Sonnet / Opus / Haiku), Gemini (2.5 Pro / 2.5 Flash), DeepSeek (Chat V3 / DeepThink R1), Mistral (Large / Medium / Small / Codestral), Qwen (Qwen3-Max / Qwen3 Coder / Turbo), Kimi (K2 / K2 Thinking / Latest), each with a `fast` / `smart` / `reasoning` badge.
- **Human clicks** — the menu button and the option are clicked through `humanClickButton()` (mouse path + press delay), with an occasional scroll before opening, consistent with the rest of the automation.

### Chip wiring (`src/chatView.ts`, `media/chat.js`, `media/chat.css`)

- **Per-provider model, persisted** — the chip stores the choice in globalState (`freekit.browserModel.<providerId>`); Ollama keeps using `freekit.ollamaModel`, and clicking a provider row no longer touches the Ollama model.
- **The active provider expands its models** — under the selected web provider the menu lists its models (indented, with badges) plus **Site default** to clear the preference; only the active provider unfolds, so the menu stays compact.
- **The chip shows `Provider · Model`** (e.g. *ChatGPT · GPT-4o*), and the choice is applied right before each message, after New Chat, in both the direct branch and the Auto chain (each provider in the chain applies its own model).
- **Failures are non-fatal** — if the model cannot be switched, a notice explains it and the message continues with the site's current model.

## 2.1.0 — 2026-10-02

**Hardware tiers + a model catalog that covers any machine** — from a 4 GB laptop to an 8×H100 workstation, the local-model suggestion is now actually right for the hardware.

### Detection (`src/hardware.ts`)

- **Every GPU, not just the first** — `HardwareInfo.gpus` now carries the full list with `vendor` (`nvidia` / `amd` / `apple` / `intel` / `unknown`), `type` (`consumer` / `workstation` / `server` / `igpu`) and `bandwidthGbps`. Classification is name-driven (Quadro / RTX A / Radeon Pro → workstation, Tesla / Instinct / A100 / H100 → server, Intel UHD / Iris / Radeon Graphics / Apple M → iGPU), and the workstation pattern uses `\b` after the exact model so an RTX 4060 is not mistaken for an RTX 4000.
- **Real memory bandwidth** — `nvidia-smi --query-gpu=...,memory.bus_width,clocks.max.memory` gives `bus width × clock × 2 / 8` (an RTX 4090 reports ~1008 GB/s). Apple Silicon gets its published bandwidth per chip family (M1 → M4 Max), because unified memory bandwidth is what decides speed there. Drivers that do not expose `clocks.max.memory` fall back to the old two-field query.
- **`totalVramGb`** — the sum over *discrete* GPUs only; iGPUs share system RAM, so counting their reported adapter memory would double-count. **`unifiedMemoryGb`** (~70% of RAM) is set for Apple Silicon, where the model has to fit in that one pool instead of VRAM + RAM.
- **Machine tier `T0`-`T6`** — `tier` is derived from the model memory budget (`max(unified, totalVram + 0.7 × RAM)`) with thresholds 4 / 12 / 24 / 48 / 96 / 192 GB. `minTierFor()` maps a model's memory back to the tier where it runs comfortably, and `tierTarget()` gives the human-readable "what can this machine run" line. Both directions use the same table, so they cannot drift.
- **Free disk** — `freeDiskGb` via `fs.statfs` on the Ollama models directory (honours `OLLAMA_MODELS`), walking up to the nearest existing path and falling back to `df -Pk`. `0` means unknown.
- **VM detection** — `isVM` from `systemd-detect-virt` / DMI on Linux, `kern.hv_vmm_present` + `hw.model` on macOS, `Win32_ComputerSystem`/`Win32_BIOS` on Windows, plus a free CPU-model check on every platform. Best-effort: a failed probe never blocks detection.

### Recommendations

- **Catalog grew from 10 to 51 models** — `qwen2.5-coder:0.5b` up to `deepseek-r1:671b` / `qwen3-coder:480b` / `llama4:maverick`. Every `needGb` was checked against the real Ollama registry manifests (blob size + KV/context headroom) instead of being estimated, and every id was verified to exist in the Ollama library.
- **Speed-aware scoring** — a model is `fast` when it fits entirely in VRAM (or unified memory), `medium` when it is an MoE with ≤10B active parameters that runs partly on the CPU (gpt-oss:20b on 32 GB RAM), and `slow` when a dense model is pushed into RAM. Ordering is speed first, quality second, so a machine is no longer told to download a 30B that only fits across CPU and GPU while a fully GPU-resident option exists.
- **One pick per size class** — the list mixes the best overall, a different size class and a smaller option, so you get three genuinely different choices instead of three near-identical models. Models that do not fit on the free disk space are skipped (unless that would leave nothing).
- **Recommendations carry `speed`, `tags` (`code` / `reasoning` / `vision` / `general` / `moe`) and `minTier`**, and the model menu labels installed models `recommended · GPU` / `recommended · CPU-friendly` / `recommended · CPU (slow)` via the new `modelSpeed()`. The hardware footer line now ends with the tier, and its tooltip lists every GPU with type and bandwidth, unified memory, free disk, VM status and the recommendations.
- **Status report** — `hardwareReport()` replaces the two ad-hoc lines: tier + target, CPU, usable memory, one line per GPU, total VRAM, unified memory, disk and environment.

> **Note:** the existing `ramGb` field kept its name (it is what `hardwareSummary` and the webview payload already used) — there is no `totalRamGb`.

## 2.0.6 — 2026-10-02

**Real keystrokes instead of pasting** — messages now arrive as genuine `keydown`/`keyup` events, which is what anti-bot checks look for, and long prompts no longer take minutes.

- **`humanType` types for real** (`src/human-behavior.ts`) — instead of pasting every character with `page.keyboard.insertText()`, text now goes through `page.keyboard.type()`, so Chrome fires real `keydown` / `keypress` / `keyup` events. Delays between characters dropped from 15-50 ms to **5-15 ms**; bursts and punctuation/thinking pauses are unchanged. Newlines are the one exception and are still written as text (`insertText`) — `type()` would send them as a real **Enter**, which in a chat composer means "send the message".
- **Long prompts stay fast** — new size strategy: up to **200 characters** the whole message is typed naturally; above that only the first **30-50 characters** are typed (enough to show the site a human typing pattern) and the rest is inserted in a single paste. Measured on the same 1000-character prompt: **29.2 s → 2.0 s**, and a 5000-character prompt now takes **~1 s** instead of tens of seconds. The old `HUMAN_TYPING_MAX_CHARS = 1500` cut-off in `src/providers/base.ts` is gone — `humanType` handles any length. Text integrity is unchanged (verified character-by-character against the previous implementation on both `<textarea>` and `contenteditable` composers).
- **Human clicks with a real press delay** — new `humanClick()` (`src/human-behavior.ts`): the mouse is moved in 2-4 steps from its current position, then `mouse.down()`, a **50-150 ms** pause, and `mouse.up()`. Called through `humanClickButton()`, which falls back to a normal Playwright click when the element has no bounding box. Used for the composer focus, the new-chat button (including the repaired selector), Stop, and the 25 s Enter-retry re-focus. The mouse path now interpolates from the last known cursor position instead of jumping in from the top-left corner.
- **Stealth patches at startup** — new `applyStealthPatches()` (`src/browser.ts`), applied from `ensureOpen()` on every page (and re-applied on navigation via `addInitScript`): `navigator.webdriver` is overridden to `false` at prototype level so it is not detectable as an own property, `window.chrome` gets a minimal stub when the browser build does not provide it, and `navigator.permissions.query` answers the `notifications` query from the real `Notification.permission` instead of leaking an automation-flavoured state. **User-Agent, viewport and timezone are deliberately left untouched** — Chrome is real and those overrides would be the suspicious part.

## 2.0.5 — 2026-10-02

**Chrome stays in the background** — the window no longer jumps in front of VS Code on every message sent or received.

- **No more bring-to-front on every send** — `sendAndWait` (`src/providers/base.ts`) used to activate the tab through CDP `Page.bringToFront`, which on Windows also restores a minimized window to the front. That call — and the now-unused `activateTab` helper — is gone. The window is brought forward **only** for login/CAPTCHA (`BrowserManager.show()` / `showTemporarily()`), which is unchanged.
- **Anti-throttling launch flags** — Chrome now starts with `--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion` (merged into the existing switch, because Chrome keeps only the last `--disable-features` value) next to the existing `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows` and `--disable-background-timer-throttling`. Rendering, timers and networking stay active while the window is minimized.
- **Page-level visibility override** — new `enableVisibilityOverride()` in `src/browser.ts`, called from `ensureOpen()`, keeps the page "visible and focused" from the site's point of view: CDP `Emulation.setFocusEmulationEnabled` + `Page.setWebLifecycleState: active`, plus a `document.visibilityState` / `document.hidden` override for the current document and future navigations (CDP has no direct visibility override). The CDP session is kept attached on purpose — Chrome resets emulation overrides when the session detaches. Everything is best-effort: a failure is only logged and never blocks a message.
- **Chrome goes back to the background after login** — when a login error brings the window forward (the v2.0.4 Retry card), the next message hides it again (`src/chatView.ts`), so the window does not stay visible after you sign in.

> **Update note:** launch flags only apply to a Chrome instance started after the update. If Chrome was already running on the CDP port, run **Freekit: Close Browser** once so it relaunches with the new flags.

## 2.0.4 — 2026-10-02

**Better login UX** — when a provider needs you to sign in, the chat no longer shows a bare “could not find the input box” error. The Chrome window comes to the front and a **Retry** button appears right in the chat.

- **Login detection when the input box is missing** — `findInput` (in `src/providers/base.ts`) now checks whether the page is actually a login page before failing: either the URL matches a login/auth pattern (`sign_in`, `sign-in`, `signin`, `login`, `auth` — without tripping over `oauth` / `author`) **or** the DOM has a visible `input[type="password"]` / a submit button labelled “Sign in” / “Log in”. When that is the case it throws `LoginRequiredError` instead of the generic “I could not find the input box…” message.
- **`LoginRequiredError` carries the provider** — the error is now `new LoginRequiredError(providerId, currentUrl)`, so the message names the provider that needs authentication.
- **Auto-show Chrome + Retry card** — when a login error reaches the send loop, Freekit brings the Chrome window to the front (so you can sign in) and posts an in-chat **login required** card with **⟳ Retry** and **👁 Show Chrome** buttons. Retry resumes the last prompt without duplicating it in the conversation history or re-sending the attachments.
- **Auto mode keeps the login error** — the `auto` fallback chain (browser → Ollama) no longer swallows a login error into its generic “Auto: all failed” message, so the Retry card still shows when the whole chain fails.

## 2.0.3 — 2026-10-02

**The ⋯ dropdown becomes the single control surface** — real codicons, no top toolbar, no red actions, and per-conversation delete on right-click.

- **Top toolbar removed** — the `menus.view/title` contribution is gone, so the 12 icon buttons that used to sit in the chat view's header no longer take up space there. Every one of those commands is still in the command palette (`Freekit: …`).
- **Codicons in the dropdowns** — all menu icons (the **⋯** menu, the model chip's provider/model list, the thinking-level menu, the conversation list and the new context menu) are now real VS Code codicons (`<i class="codicon codicon-…">`) instead of the hand-drawn SVG sprite. `@vscode/codicons` is a dependency, but only `codicon.css` + `codicon.ttf` are vendored into `media/` and the rest of the npm package is excluded from the VSIX. The sprite shrank from 21 symbols to the 10 still used outside menus (header buttons, composer, in-chat rows).
- **Delete conversation moved to a context menu** — the item is gone from the ⋯ menu: **right-click any row** in the Conversations list to get a small menu at the cursor with **Delete conversation**. It deletes *that* conversation (the host now accepts an id) instead of only the active one, and the chat is re-rendered only when the deleted conversation was the active one. The native modal confirmation is unchanged, and the row tooltip mentions the gesture.
- **Clear chat is no longer red** — the last `.mi.danger` item lost its colour, and the now-unused `.danger` rule was removed, so no menu entry shouts at you any more.

## 2.0.2 — 2026-10-02

**Ollama install helper + hardware-aware model recommendations**, plus UX polish for the chat panel's ⋯ menu.

### Ollama — install button and hardware detection

- **`Freekit: Install Ollama` (`freekit.installOllama`, `$(cloud-download)`)** — opens <https://ollama.com/download> in the external browser. If a binary is already present but the server is not running, the page is **not** opened: the command says to start it with `ollama serve`.
- **Install row in the model menu** — when no `ollama` binary can be found, the **Local · Ollama** section of the model chip starts with *Install Ollama…*, and an *Install Ollama* entry shows up in the ⋯ menu (Context) **only** while Ollama is missing. Both send `install_ollama` to the Extension Host.
- **Hardware detection** (new `src/hardware.ts`, pure Node — no `vscode` import) — RAM and CPU via `os`, VRAM via `nvidia-smi`, then Windows (`Win32_VideoController` + `HardwareInformation.qwMemorySize` from the registry — `AdapterRAM` is a 32-bit field capped at ~4 GB), then macOS (`system_profiler SPDisplaysDataType -json`), then Linux sysfs (`mem_info_vram_total`). Virtual adapters (RDP / streaming / virtual displays) are filtered out and the result is cached for the session.
- **Recommended models in the model menu** — a catalog of Ollama models with their approximate Q4_K_M memory needs is filtered against ~70 % of the detected RAM, ranked largest-first, and each entry explains what will happen (*fits in 8 GB VRAM — runs on the GPU* / *partial GPU offload on 8 GB VRAM, the rest on the CPU* / *runs on the CPU*). Recommendations that are already installed are tagged **recommended** next to their disk size; the ones that are not become one-click **download** rows — `ollama pull` runs with live progress in the notification bar (cancellable) and the pulled model becomes the active one.
- **Hardware line under the model list** — e.g. `Radeon RX 580 Series · 8 GB VRAM · 15.9 GB RAM`, with the full recommendation list and its reasons in the tooltip. `Freekit: Show Provider Status` now also prints the hardware summary, the CPU (threads) and the recommendations.

### Chat panel ⋯ menu polish

- **⋯ menu grouped into sections** — the flat list became four labelled groups (`.mh` header + `.sep`): **Context** (*Show Chrome*, *Open Browser*, *Stop dev servers*, *Provider status*), **Session** (*New chat*, the conversation list, *Delete conversation*), **Debug** (*Verbose logs*, *Diagnostics*, *MCP servers*, *Reset repaired selectors*) and **Settings** (*Settings*, then *Clear chat* in red).
- **New menu actions** — *Open Browser* (`freekit.openBrowser`), *Stop dev servers* (`freekit.stopDevServers`) and *Reset repaired selectors* (`freekit.resetSelectors`) are now reachable from the ⋯ menu (they were previously only in the command palette / view title). *New chat* is also mirrored in the menu. Three new sprite icons (`i-globe`, `i-power`, `i-wrench`).
- **Confirmation for destructive actions** — *Clear chat* and *Reset repaired selectors* no longer run on the first click: the Extension Host shows a **modal** warning (`Yes, clear` / `Reset`), and *Cancel* does nothing. The chat UI is cleared only after the confirmation arrives back in the webview (`cleared` message), and an in-flight response is stopped first.
- **Stop button state** — the Stop button is now driven by an explicit `busy` message from the Extension Host (`1` while a response runs, `0` when it ends, plus a re-sync on webview reload), so it is hidden when nothing is generating. Rendering the final reply / stopped / error message now runs in a `try`/`finally`, so `busy` can never stay stuck if rendering the answer throws.

## 2.0.1 — 2026-10-02

**UX redesign of the chat panel** (implementation of the Claude mockup): same features, new layout, plus inline file-change rows.

- **New layout** — minimal header (**Freekit** + *New chat* + **⋯** menu), a scrollable `#chat` transcript and a **full-width composer**: a dimmed context row (**model chip**, **thinking chip**, **Auto** switch) above the input box, with attach / folder / stop / mic / send actions inside it. The old top toolbar and the conversation `<select>` bar are gone.
- **Inline file change rows** — every `write_file` / `edit_file` review renders a row in the chat (file icon, filename, **+added / -removed** stats, **Reject** / **Approve**). Clicking the filename re-opens the **native VS Code diff**, and the row switches to **Applied** / **Rejected** as soon as any path decides (inline row, native diff buttons, the VS Code notification, auto-approve or Stop) — first decision wins, and a row can be decided only once. The earlier preview card is kept only as the fallback for reviews without rows.
- **Diff stats from the real contents** — new `computeDiffStats()` in `src/tools.ts` counts added/removed lines with a line-level LCS (memory `O(min(n,m))`), falling back to a linear heuristic above 3000 lines so very large files never stall the agent loop.
- **Model chip with a status dot** — the provider dropdown became a chip fed by a new `providers_list` message, grouped into **Browser accounts** and **Local · Ollama** (live model list from `/api/tags`). Green = browser account signed in, blue = local Ollama, orange = sign-in or browser needed. Selecting an entry sends `provider_change` and persists `freekit.provider` (plus `freekit.ollamaModel` for local models).
- **Thinking level chip (Off / Low / Medium / High)** — new `freekit.thinkingLevel` setting (default `medium`). Choosing a level updates the chip, is mirrored into the webview state and stored in the setting. UI + storage only for now — it does not change model behaviour yet.
- **⋯ menu** — Show Chrome, **Verbose logs** (now a check item with On/Off sub-text and a dot on the button), Provider status, Diagnostics, MCP servers, Settings and Clear chat, plus the **conversation list** (switch to any conversation, delete the current one) that used to live in its own bar.
- **Auto-approve switch** — the lightning checkbox is now the mockup's switch (`aria-pressed`; orange track and moved knob when on) and still persists to `freekit.autoApprove`.
- **Thinking card preview** — the collapsible card now shows the first ~60 characters in italics while collapsed and hides the preview when expanded.
- **Everything else preserved** — native diff flow, Accept / Reject / *don't ask again* notifications, per-prompt git checkpoints, edit prompt / fork / multiple conversations, TTS and voice input, auto-verify + rollback and MCP servers. Menus close on outside click and on `Esc`.

## 2.0.0 — 2026-10-02

**Rebranding: AI Bridge → Freekit.** The extension is now published as **`builderweb.freekit`** (landing page: <https://builderweb.app/agent>).

- **New identity** — `name: freekit`, `displayName: Freekit`, `publisher: builderweb`, version `2.0.0`.
- **All command IDs** renamed from `aiBridge.*` to `freekit.*` (e.g. `freekit.openBrowser`), the activity-bar container `aiBridge` → `freekit` and the chat view `aiBridge.chatView` → `freekit.chatView`.
- **All settings** renamed from `aiBridge.*` to `freekit.*` (e.g. `freekit.provider`, `freekit.autoVerify`, `freekit.mcpServers`, `freekit.semanticIndex.*`).
- **Automatic state migration** — on activation, the previously used persisted `globalState` keys (`aiBridge.history`, `aiBridge.conversations`, `aiBridge.checkpoints`, `aiBridge.selectorOverrides`, …) are copied to their new `freekit.*` names when both live in the same storage scope (the legacy keys are left in place for a safe rollback). ⚠️ Because both the **publisher** and the **extension name** changed, VS Code assigns the extension a **new identity** (`local.ai-bridge` → `builderweb.freekit`) and therefore a **new storage scope**: settings, keyboard shortcuts and the previous chat history must be re-created. Re-apply your settings under the new `freekit.*` keys (e.g. `freekit.provider`, `freekit.chromePath`, `freekit.mcpServers`) and re-bind any shortcuts that pointed at `aiBridge.*` commands.
- **Internal markers** renamed too (`data-freekit-*` DOM attributes, `__freekitTracker`, `freekit-prompt:` / `freekit-backup-before-restore:` git checkpoint commit markers, MCP client name, temp folders).

## 1.10.3 — 2026-10-02

- **Collapsible 🧠 *Thinking* card (Cline-style)** — the reasoning card now stays **expanded with the live text while the model is thinking**, then **collapses on its own** as soon as the visible answer (or an action) starts streaming. A ▼/▶ arrow in the header shows the state and clicking the header toggles the card **manually** at any time, so you can re-read the full reasoning whenever you want.
- **Thinking duration** — the header now reads **🧠 Thinking (2.3s)** once the reasoning is done, accumulating the total time the model spent thinking across the whole prompt (each reasoning segment adds up, measured down to a tenth of a second).

## 1.10.2 — 2026-10-02

- **Thinking text no longer repeated in the 🧠 card** — web providers read “the last reasoning block on the page” at every step of the agentic loop, and the block from the previous step stays mounted, so the very same reasoning was reported (and appended) once more and the collapsed 🧠 *Thinking* card showed it twice (and once more for every extra step). Each block is now displayed only once, and if a block has grown between reads only the new part is appended.

## 1.10.1 — 2026-10-02

- **Restore checkpoint also rewinds the conversation** — ⟲ *restore* used to reset the files with `git reset --hard` but left the transcript untouched, so the chat still showed the prompts and replies that belonged to the discarded state. It now truncates the active conversation right after the restored prompt (the same `truncateAfter` used by *edit prompt*), then refreshes the conversation dropdown and re-renders the chat. The `checkpoint_restored` message is still sent last, so the ✓ badge on the message behaves exactly as before.

## 1.10.0 — 2026-10-02

- **Semantic code search (`search_semantic`)** — the AI can now find code by **meaning** instead of exact text: ask *"where do we validate the login token?"* and it gets the closest snippets back, each with `path:startLine-endLine`, a cosine-similarity score and the code itself. The tool is exposed to every provider through the same one-line-JSON tool-call format (and added to the local-model prompt, `SYSTEM_PROMPT_LOCAL`), is read-only (no approval card), and degrades gracefully: when there is no index yet it tells the model to fall back to `search_files`. The `SYSTEM_PROMPT` tool list already advertised `search_semantic` — it is now actually implemented.
- **Local, private, zero-dependency index** — embeddings are computed by your own Ollama server (`freekit.ollamaUrl`) with `nomic-embed-text` (768-dim) via a new `src/indexer/` module, and the vector store is a **single JSON file in globalStorage** (`<globalStorage>/semantic-index/<workspace>-<hash>.json`) — no new npm dependencies, no cloud, nothing leaves the machine. Writes are atomic (temp + rename) and the index is cached in memory (invalidated by mtime) so repeated searches don't re-parse the JSON.
- **Three commands** — `Freekit: Index Workspace` (incremental, cancellable, with live per-file progress in the notification and the outcome mirrored into the chat), `Freekit: Index Status` (model, dimensions, indexed/skipped files, chunk count, storage path + size, timestamps, on-save state) and `Freekit: Clear Index` (modal confirmation, deletes just this workspace's vector store).
- **Incremental indexing** — every file is fingerprinted with a SHA-1 of its content; unchanged files keep their existing vectors, so re-indexing after an edit only re-embeds what actually changed. Optionally keep the index fresh **on save** (`freekit.semanticIndex.onSave`, debounced 1.5 s) — off by default, and a no-op when the workspace was never indexed.
- **Smart exclusions & chunking** — `node_modules`, `.git`, `out`, `dist`, `build`, `.next`, `.astro`, `coverage`, virtualenvs, `target`, caches, lockfiles, source maps, minified files and binaries are skipped (extendable via `freekit.semanticIndex.exclude`), files above `freekit.semanticIndex.maxFileKb` (256 KB) are ignored, and text is split into 60-line chunks with a 12-line **overlap** so a function straddling a boundary is still found. Changing the embedding model invalidates the old index automatically.
- New settings: `freekit.semanticIndex.enabled` (default `true`), `.model` (`nomic-embed-text`), `.onSave` (`false`), `.maxFileKb` (`256`), `.topK` (`8`) and `.exclude` (`[]`), plus the three commands in the command palette and the chat view title bar.

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

- **Dev servers now run in a visible VS Code terminal** — until now `npm run dev` / `npm start` / `serve` / `watch` / `preview` commands were started as detached background processes: the AI got the PID and the early output, but **you saw nothing** — no compile progress, no errors, no "ready" URL. Every long-running command now starts in a dedicated, **visible terminal** (named `Freekit: dev` / `Freekit: serve` / … in the bottom panel): you watch the live output and **Ctrl+C in that terminal stops the server** exactly like a command you typed yourself. The server keeps running after the AI finishes — stop it with Ctrl+C or with `Freekit: Stop Dev Servers`, which now sends Ctrl+C to each server's terminal and only closes the terminal if the process ignores it.
- **Live capture via the stable Shell Integration API** — the first ~3 s of output (plus the detected **live URL** and fast startup errors like "port already in use") are captured with the standard Shell Integration API (`terminal.shellIntegration.executeCommand()` + `execution.read()`, VS Code 1.93+). The implementation deliberately avoids `onDidWriteTerminalData`, which is still a *proposed* API — for a sideloaded VSIX it is silently filtered out at runtime unless VS Code is launched with `--enable-proposed-api`, so it could never capture anything in normal use. If shell integration is unavailable for a shell, the command still starts visibly and the AI gets a `⚠️` note that live capture was off (instead of silently losing the output).
- **Friendlier failure handoff** — when the process exits during the grace window (occupied port, syntax error, missing deps) the AI receives the full captured output, the exit code and a note that the terminal stays open so you can read the errors yourself; the terminal is no longer closed automatically. Anti-duplication, the stop command and the `DEV-SERVER NOTE` self-correction flow keep working — servers are now identified by their terminal name instead of PID.

## 1.8.0 — 2026-10-01

- **Chrome now runs completely in the background — no more taskbar button** — until now the window was only parked offscreen (`-32000,-32000`), which still left a visible taskbar entry. The window is now **minimized** (CDP `Browser.setWindowBounds`) and on Windows its taskbar button is removed entirely by setting `WS_EX_TOOLWINDOW` on the main window (a small `user32.dll` helper driven by PowerShell `Add-Type` — the same native-helper pattern as the v1.7.3 audio recorder); the window also disappears from Alt+Tab. `--start-minimized` is now part of the launch flags as well (Chrome ignores it for windows created later, so the explicit CDP minimize right after connect covers that path).
- **Automation, rendering and page JS are unaffected** — verified E2E: with the window minimized + taskbar-hidden the page keeps executing timers, `document.visibilityState` stays `visible` (thanks to the existing `--disable-backgrounding-*` flags) and CDP/Playwright control (evaluate, screenshots, clicks) keeps working; the offscreen position stays as a second safety net.
- **Show Chrome restores everything** — 👁 Show Chrome, the login assist and the new CAPTCHA assist bring the window back on screen (normal state + taskbar button + focused tab) so you can interact with it, then hide it to the background again afterwards.
- **CAPTCHA auto-show** — when a provider page presents a real CAPTCHA challenge (reCAPTCHA challenge frame, hCaptcha challenge, Cloudflare “Just a moment”/challenge page, DataDome), Freekit now brings Chrome on screen automatically (same pattern as the login assist), waits for you to solve it (up to 5 minutes, URL/DOM polled every 2.5 s), then hides the window again and continues by itself. Detection is conservative — the invisible reCAPTCHA v3 badge / hidden widgets never trigger it. Stop aborts the wait and hides the window immediately.
- **Auto-accept for consent popups** — cookie banners and terms/consent dialogs are now closed automatically: after a page load, before clicking New Chat and right before typing a message. Three confidence tiers — strong (“Accept all”, “Accept all cookies”, “Acceptă toate”), medium (“Accept”, “I agree”, “Got it”), weak (“OK”, only inside dialogs/banners/modals) — with exact matching on the normalized button text, links only for the top tier, and refusal wording (Reject / Only necessary / Customize / Manage settings / Not now / Close…) never clicked; cross-origin iframes are scanned too (Google's consent banner lives in one). At most 3 clicks per pass, and every clicked element is marked (`data-freekit-accepted`) so the same button is never pressed twice. Disable with the new `freekit.autoAcceptPopups` setting (default on).
- A chat notice reports popups closed during a send and the CAPTCHA wait/solved/expired states.

## 1.7.5 — 2026-10-01

- **Restore button icon changed to ⟲ (U+27F2)** — the checkpoint restore button on user messages now shows the anticlockwise gapped circle arrow instead of the previous emoji; the same symbol is used in the restore confirmation dialog, the “checkpoint restored” notice, the missing-git explanation and the settings / README descriptions. No logic changes (the ✅ marker shown after a successful restore stays as it was).

## 1.7.4 — 2026-10-01

- **Long-running commands no longer block the AI — dev servers run in the background** — `npm run dev`, `npm run serve`, `npm start`, `watch` / `preview` scripts and known dev binaries (`vite`, `nodemon`, `next dev`, `astro dev`, `ng serve`, `uvicorn`, …) are now detected **before** execution and started with `spawn` instead of being awaited by `exec` (previously: 60–180 s timeout → the agent loop stalled on a command that never exits). On macOS/Linux the child is `detached` (own process group); on Windows it runs as a plain background child — `detached` + `cmd.exe` silently loses the process output (verified during development), so capture uses the non-detached shell and stopping is done with `taskkill /T`. The AI immediately receives `✅ Server pornit în background (PID: …)`, the detected live URL(s) and the first ~2.5 s of output — so fast startup errors (port already in use, syntax error, missing deps) are still captured and reported as a normal failed command with the self-correction directive.
- **Detection by script name + word patterns** — exact names (`dev`, `start`, `serve`, `watch`, `preview`, `storybook`, `develop`, `nodemon`, `hot`, `live`, `start:dev`, `dev:server`) plus `\bdev\b` / `\bserve\b` / `\bstart\b` / `\bwatch\b` / `\bpreview\b` patterns (`dev:client`, `test:watch`, `start:prod` …). Works for `run_npm` script calls and for raw `run_command` strings: `npm/pnpm/yarn/bun [run] <script>`, chains (`cd app && npm run dev`, `npm install && npm run dev`), `npx vite`, bare binaries (`vite`, `parcel`, `nodemon server.js`), `--watch` flags (`npm run build -- --watch`, `tsc --watch`) and Python (`manage.py runserver`, `flask run`). One-shot subcommands (`vite build`, `next build`, `wrangler deploy`) are never misdetected.
- **New command `Freekit: Stop Dev Servers`** (also in the chat view title) — stops every dev server the extension started: tree kill on Windows (`taskkill /PID … /T /F`) and process-group `SIGTERM` → `SIGKILL` on macOS/Linux, with per-PID reporting of the stopped and failed ones. The same server (command + folder) is never started twice while it is still running (the AI gets the existing PID instead).
- **No orphaned processes** — the process registry is in-memory, so on window close the remaining servers are stopped best-effort; output pipes are capped (48 KB) and unref'ed after the grace window, so the detached server keeps serving without holding the extension host.

## 1.7.3 — 2026-10-01

- **Voice input repaired — audio capture moved to the Extension Host** — the 🎤 button no longer records inside the webview (`getUserMedia` / `MediaRecorder` are blocked by the VS Code sandbox → `NotAllowedError`, no microphone access). Capture now runs in the extension's own Node.js process, which always has access to the system microphone.
- **Native Windows capture with zero dependencies** — on Windows the recording is done by a small C# recorder over `winmm.dll` (the classic waveIn API), compiled at runtime by PowerShell `Add-Type` from a script generated by the extension: 16 kHz mono 16-bit WAV, ready for whisper.cpp — no SoX, nothing to install. (The npm `node-audiorecorder` package was investigated for this exact job, but it is unmaintained, is based on node-record-lpcm16 and still requires SoX (`rec`) on every platform — its code contains no native Windows backend, so it could not replace SoX.)
- **Cross-platform fallback** — on macOS/Linux (or Windows without PowerShell) the capture falls back to `node-audiorecorder` (SoX `rec`) when it is available in PATH; streaming RIFF sizes written by SoX into the pipe are repaired after capture.
- **Same recording UX, clearer failures** — 🎤 starts the capture (`🎤 Pornesc microfonul…` → `🎙 Se înregistrează… (m:ss)` with a pulsing button and live timer; stop with ⏹ or by sending a message), then `⏳ Transcriu audio (Whisper local)…` while whisper.cpp transcribes locally and the transcript is appended to the message box. Missing microphones, permission problems and script errors surface as clear chat notices, and a 10-minute safety limit auto-stops runaway recordings (the transcript still arrives).
- The obsolete `stt_audio` webview→host base64 audio path and the in-page WAV conversion were removed; `freekit.sttLanguage` is now read by the extension at transcription time.

## 1.7.2 — 2026-10-01

- **Voice input rebuilt on local Whisper (100% offline)** — the 🎤 button no longer uses the Web Speech API (unavailable in Electron without Google services). It now records with **MediaRecorder** in the webview, converts the audio to 16 kHz mono WAV in-page (decode + resample; no ffmpeg needed) and sends it to the extension, which transcribes it with **whisper.cpp** — fully offline, Romanian + English.
- **One-time setup command** — `Freekit: Setup Local Whisper` downloads the official prebuilt whisper.cpp binaries (v1.9.2, BLAS x64, ~20 MB) and the `ggml-base` model (~141 MB) into global storage; the engine is resolved automatically afterwards (settings → global storage → classic whisper.cpp locations → PATH).
- **Recording UX** — the button shows ⏹ + a pulsing red state while recording and the input shows a live timer (`🎙 Se înregistrează… (0:07)`); while transcribing it shows ⏳ / `Transcriu audio (Whisper local)…`, and the transcript is appended to the message box. Microphone, permission, conversion and engine errors all produce clear chat notices.
- **Why not nodejs-whisper** — it builds whisper.cpp via CMake at runtime (needs a build toolchain); v1.7.2 drives the same upstream engine through the official prebuilt binaries instead. `freekit.whisperCliPath` / `freekit.whisperModelPath` accept any custom whisper.cpp build.
- The Web Speech API code path was removed; `freekit.sttLanguage` now selects the Whisper language (applied at the next transcription).

## 1.7.1 — 2026-10-01

- **Verbose mode (diagnostic transparency)** — a new 🔍 toggle in the toolbar shows every step the AI takes, live in the chat, grouped by type: **🧠 Thinking** (the model's reasoning), **⚙️ Executing** (tool runs with the exact command/target), **📄 Result** (tool output previews, capped at 4 000 chars) and **🔀 Decision** (tool choice, auto-retry, auto-repair and rollback decisions). Every step is collapsible (click its header); running steps pulse until they finish and long steps (Thinking / Result) fold themselves automatically. Off by default = only the final answers, exactly as before — the toggle is persisted across sessions.
- **Reasoning capture (DeepSeek-R1 / Claude extended thinking / Gemini / Qwen / Kimi / Ollama)** — providers now expose the model's thinking separately from the final answer: `AIProvider.onThinking` is called by web providers with the reasoning block extracted from the page (per-provider selectors + generic fallbacks, echo- and UI-safe, best-effort) and by local Ollama models with the `thinking` / `reasoning_content` field. It shows up as a single collapsed 🧠 Thinking card per prompt (accumulated across the agentic loop).
- **Chat ordering** — verbose step cards are inserted between your message and the in-progress answer, so the process reads top-to-bottom: prompt → steps → final reply.

## 1.6.0 — 2026-10-01

- **Voice input (speech-to-text)** — a new 🎤 button next to the attachment buttons dictates your message with the Web Speech API: interim results preview live in the input placeholder, finalized phrases are appended to the message box (whatever you already typed — or dictated earlier — is kept), and the textarea grows/scrolls like normal typing. Click the button again to stop; sending a message or clearing the chat stops listening automatically, and the button turns red with a soft pulse while recording.
- **Romanian + English** — pick the dictation language with the new `freekit.sttLanguage` setting (`ro-RO` default, `en-US`); the change applies live, without reloading the webview.
- **Safe failure modes** — environments without the Web Speech API, a blocked microphone or a missing speech service produce a clear chat notice instead of a silent no-op; transient `no-speech` events simply keep the session alive, and fatal errors stop the session cleanly (the browser-side auto-restart can never loop).

## 1.5.0 — 2026-10-01

- **Restore button now always appears — automatic `git init`** — before this release, projects that were not git repositories silently skipped checkpoint creation, so the 🔄 restore button never showed up (no error, no explanation). Now, with `freekit.autoInitGit` on (default), the folder gets a `git init` (plus a minimal `.gitignore` if none exists, so `node_modules/` and build output stay out of the first commit) right before the first checkpoint, and the chat announces it. If git is missing entirely, a one-time chat notice explains why there is no 🔄 button.
- **Hardened message↔checkpoint wiring** — the user-message id is attached to the chat bubble directly in `add()` (one single code path), and restore buttons are re-attached after every user message, so the 🔄 button can no longer miss its checkpoint because of message ordering (e.g. right after a webview reload).
- **Text-to-speech for AI replies** — every assistant message gets a 🔊 button (next to Copy) that reads the answer aloud via the Web Speech API, with a Romanian voice when one is installed (`ro-RO`). Long answers are split into sentence-sized chunks so speech engines don't cut them off, and markdown (code blocks, links, emphasis) is stripped first. Click the button again to stop; reading also stops when you clear the chat or send a new message.

## 1.4.0 — 2026-10-01

- **Automatic git checkpoint before every prompt** — right before your message is sent, Freekit snapshots the project in git with a temporary marker commit (`freekit-prompt:<id>`): a dirty working tree is committed as-is (the checkpoint is exactly what you had before the prompt) and a clean tree gets an empty marker commit — every prompt gets its own unique restore id. Repos without a configured git identity are handled automatically (bot identity fallback). No-op in non-git projects; toggle with `freekit.promptCheckpoints`.
- **One-click restore in the chat** — every user message with a checkpoint shows a small 🔄 button above it (re-attached to historical messages after a chat reload, via global state). Clicking it asks for confirmation and runs `git reset --hard <checkpoint>`, bringing the project exactly back to the state before that prompt. The current state is first saved as an automatic backup commit (`freekit-backup-before-restore:<ts>`) whose short hash is shown in the chat — nothing is lost. Untracked files are left on disk and reported.
- **Checkpoint history** — the last 50 checkpoints (message id, prompt snippet, commit hash, timestamp, dirty/clean flag) are persisted in global state.

## 1.3.0 — 2026-10-01

- **Auto-verify after every edit** — after each `edit_file` / `write_file` / `write_files` the project is checked automatically: `astro check` (when `@astrojs/check` is installed), `tsc --noEmit` (Next / Vite / any tsconfig project with TypeScript), or the detected `typecheck` / `build` / `lint` script — picked from `package.json`, dependencies and lockfile (`npm` / `pnpm` / `yarn`), with a 120 s timeout. Results appear in the chat and in the Output channel.
- **Auto-repair loop** — when the check fails, the **full error output** goes back to the AI with an `AUTO-REPAIR` directive (find the root cause → fix with `edit_file` / `write_file` → the system re-verifies automatically). Max **3 auto-repair attempts** per failing streak; a recovery is announced in the chat (`✅ Auto-verify … passes again`).
- **Automatic rollback** — if the project still fails after 3 repair attempts (or the model stops with the check still red), all edits made since the last passing verification are **rolled back automatically** to the last known-good state (pre-edit snapshots are taken before every write; brand-new files are deleted), the user gets a VS Code warning, and the chat shows exactly what was reverted plus the last error. The project is never left broken.
- **Safety net details** — verification is skipped when no check can be detected (e.g. plain Python) and can be disabled with the new `freekit.autoVerify` setting (default on).

## 1.2.1 — 2026-10-01

- **In-chat Accept / Reject for diff reviews (fallback for the VS Code notification)** — when a file write opens the native diff, the decision buttons now also appear **directly in the chat**: an inline review card with a diff preview and **✓ Accept / ✗ Reject**. It shows **in parallel** with the usual VS Code notification (which is often hidden, expires or never renders) and **whichever you click first decides the review** — both paths resolve the exact same pending approval. Dismissing the notification no longer ends the flow on a fallback card: the chat card stays active until you decide, Stop / ⚡ auto-approve still resolve it instantly, and the card is re-posted automatically if the webview reloads while the review is pending.

## 1.1.2 — 2026-10-01

- **Forced tool calls (rewritten system prompt)** — the model must answer every action request with a **single-line tool-call JSON** (`{"tool": "NAME", "args": {...}}`) — no introductions, no “Analyzing… / Let me… / I'll…”, no markdown fences — and gets strict **workflow examples** (search → read → edit, file creation, comment insertion, running tests). `PROJECT INFO` / `PROJECT STRUCTURE` are now injected through `{PROJECT_INFO}` / `{PROJECT_STRUCTURE}` placeholders inside the prompt itself.
- **Auto-retry when the reply contains no tool call** — if the model replies with descriptive text (“Analyzing the project structure…”) or a malformed JSON fragment instead of a tool call, Freekit automatically sends a strict **“NO TOOL CALL DETECTED”** nudge that demands exactly one single-line tool call (max 2 per message, visible in chat as `🔁 Auto-retry n/2`). Genuinely final answers pass through untouched.

## 1.1.0 — 2026-10-01

- **MCP (Model Context Protocol) client** — Freekit can now launch user-configured MCP servers (stdio transport, JSON-RPC 2.0 over newline-delimited messages), discover their tools (initialize handshake → `tools/list`, cursor pagination supported) and **expose them to the model as extra tools** named `mcp_<server>_<tool>`. The tool list (names, parameter names, short descriptions) is appended to the system prompt on every message — with a tighter cap for local Ollama models; the generic `{"tool":"mcp_call","args":{"server","tool","arguments"}}` alias is also accepted.
- **Configuration** — servers are read from **`.vscode/mcp.json`** (VS Code format `{"servers": {...}}`; the Claude-Desktop `{"mcpServers": {...}}` shape is accepted too) or from the new **`freekit.mcpServers`** setting. The file watcher + settings listener hot-reload everything (debounced), `freekit.mcpEnabled` is the master switch and `freekit.mcpToolTimeoutSeconds` (default 60) caps each `tools/call`.
- **Approval-based execution** — every MCP call goes through the same approval flow as shell commands (card shows server, tool and arguments; ⚡ auto-approve applies automatically); results and failures return to the model as normal `TOOL_RESULT` / `TOOL_ERROR` messages, so the agentic loop keeps working.
- **Management UI** — new command **`Freekit: MCP Servers`** (also in the view title toolbar): per-server status (🟢 running / 🔴 failed / ⚪ stopped), restart / stop / show tools per server, "restart all", "show all tools", "open or create `.vscode/mcp.json`". MCP status also appears in **Show Provider Status** and **Diagnostics**.
- **Robustness** — spawn failures fail fast (no timeout hang), crashed servers are reported with their stderr tail, in-flight requests are rejected when a server exits, unsupported server→client requests (sampling/roots) get a proper JSON-RPC error, and Windows `.cmd` shims (`npx`, `npm`, ...) are launched through a shell with quoted arguments.

## 0.9.5 — 2026-10-01

- **AI-powered selector discovery (fallback)** — when the classic fingerprint healer finds no candidate at all (or every candidate is dropped by the blacklist/fragile rules), Freekit now captures a **cleaned DOM snapshot** of the page (scripts/styles/SVG/cookie banners stripped, `on*`/`style`/`data-react*` attributes and input values removed, head+tail capped to fit the local model context) and asks the local **Ollama** model (`freekit.ollamaModel`) for stable selectors — `input` / `response` / `newChat` / `stopButton`. Proposed selectors are validated against the live page (must exist, be visible, be unique enough, be editable for `input`, carry real text for `response`) and re-checked with the same safety guards as the healer (promo/blacklist/fragile/echo rules, no user bubbles); only then are they applied immediately, persisted with the other learned overrides and written to **`selectors-user.json`** in global storage (auto-reloaded at startup, invalid entries pruned automatically).
- **Fail-open and rate limited** — the fallback never blocks the normal flow: at most one attempt per provider/slot/site every 5 minutes, a configurable timeout (`freekit.aiFinderTimeoutSeconds`, default 45 s, Ollama call is aborted on expiry), and it is skipped silently when Ollama is not reachable. Toggle with `freekit.aiSelectorFinder` (default on).

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

- **Auto-show Chrome at login** — when a web provider lands on a login/auth page (e.g. Mistral, Qwen or Kimi not yet signed in), Freekit now brings the hidden Chrome window on screen automatically, posts a chat notice, waits for the login (URL polling, up to 5 minutes) and then hides the window offscreen again and continues by itself. Pressing Stop aborts the wait and hides the window immediately.
- **Mistral selector fixes** — better `response` / `newChat` alternatives in `selectors.json`; the healer blacklist now also covers theme/UI chrome (`theme`, `toggle`, `dark`, `light`, `mode`) and secondary text blocks (`subtle`). `dark`/`light`/`mode` are matched as full tokens only, so Tailwind `dark:...` classes, `font-light`, `highlight` and `model` selectors are never misclassified. Selectors containing theme/toggle tokens are rejected when the healer tries to persist them, and previously learned bad overrides (Mistral's `Toggle theme` as newChat, `text-subtle` as response) are purged automatically at startup.

## 0.9.0 — 2026-10-01

- **Three new browser providers** — **Mistral (Vibe)** (`chat.mistral.ai`), **Qwen** (`chat.qwen.ai`) and **Kimi** (`kimi.com`) join DeepSeek, ChatGPT, Gemini and Claude. They run through the same hidden Chrome/CDP pipeline (human-like typing, selector self-healing, native diff approvals), appear in the provider dropdown and can be used as the first hop of the **Auto** chain (last used web provider → Ollama).
- **`preferredKeywords` for selector healing** — selector slots can now declare preferred keywords (e.g. `assistant`, `markdown`, `chat`); during auto-repair, candidates matching them in their own attributes (class/id/aria-label/placeholder) get a scoring bonus. Bundled for the new providers and carried through remote Gist configs.

## 0.8.1 — 2026-10-01

- **MutationObserver is now opt-in — `freekit.mutationObserver` default changed to `false`.** The observer proved flaky while Chrome runs offscreen (at `-32000,-32000` Windows suspends JavaScript for invisible windows, so the “quiet DOM” signal wasn't always delivered and the wait could stall). The reliable 500 ms polling is the default again; set `freekit.mutationObserver` to `true` to opt back into the experimental fast detection.

## 0.8.0 — 2026-10-01

- **Human-like typing** — messages are typed character by character with randomized delays (15–50 ms), punctuation pauses and occasional fast bursts instead of instant insertion (anti-detect); typing can be cancelled with Stop (partial input is cleared best-effort) and messages longer than 1500 chars (e.g. embedded attachments) fall back to instant paste. Toggle: `freekit.humanTyping` (default on).
- **Instant completion detection (MutationObserver)** — the response wait is now driven by an in-page MutationObserver: a quiet DOM ends the wait step immediately instead of a fixed 500 ms poll (much less CPU). Selector healing checkpoints, the 25 s Enter retry, the 2 s text-stability rule and the rescue extraction all stay. Toggle: `freekit.mutationObserver` (default on; off = classic polling).
- **Human-like behavior** — small randomized mouse moves before clicking the composer, New Chat and Stop, plus an occasional gentle scroll. Toggle: `freekit.humanBehavior` (default on).

## 0.7.1 — 2026-10-01

- **24 h rate limit for the startup selector check** — the automatic check at activation runs at most once every 24 hours (any check — manual or automatic — resets the timer); `Freekit: Update Selectors` always works on demand and reports the result.

## 0.7.0 — 2026-10-01

- **Remote selector config (GitHub Gist)** — selector fixes are now deployable to every client **without an extension update**: point `freekit.selectorsUrl` at a public Gist whose `selectors.json` carries a `version` (plus optional `updated` / `changelog`). New versions are downloaded, strictly validated, merged over the bundled config and cached in global storage; the bundled selectors remain the fallback when the Gist is missing, older or unreachable.
- **`Freekit: Update Selectors` command** (also in the view title) — manual update from the configured Gist, showing the version transition and the changelog.
- **Optional startup check** — `freekit.checkSelectorsOnStartup` (default `true`) refreshes selectors silently at activation; local auto-repairs for the slots a remote update touches are replaced by the curated fix, and diagnostics now report the active selector source.

## 0.6.1 — 2026-10-01

- **Tolerant tool-call parsing** — recovers tool calls when the model omits escaping around double quotes inside JSON string values.

## 0.6.0 — 2026-10-01

- **Terminal self-correction (auto-healing)** — when a command fails (`run_command`, `run_npm`), the AI receives the **FULL output** (stdout and stderr separately, exit code, duration — no more bare “exit code 1”) plus a **SELF-CORRECTION directive**: find the root cause → fix the code (`edit_file` / `write_file`) → re-run the same command.
- **Hard retry limit** — max **5 attempts per command** (per message). After 5 failures the command is **blocked**: running it again returns an error instead of executing, and the model must reply with plain text explaining what remains broken.
- **Visible healing status in chat** — `⟳ Auto-healing 2/5: “npm run build” failed (exit 1, 3.4s)…`, `✅ fixed after N attempts`, `⛔ command blocked`. Counters reset on success and at every new message.

## 0.5.0 — 2026-10-01

- **Native diff review** — file writes (`write_file`, `edit_file`, `write_files`) no longer use the in-chat text card. Freekit opens a **native VS Code diff editor** (left = current content, right = proposed content; the real file is untouched until you accept) and asks with **Accept / Reject** buttons. Multi-file batches open the multi-diff view.
- **"Accept (don't ask again)"** — per-file opt-out from the diff notification, persisted across sessions. New command **`Freekit: Clear No-Ask File List`** resets it (also in the view title toolbar).
- **Safe fallback** — if the diff can't be opened, or the notification is dismissed without a choice, the classic in-chat approval card still handles the decision.
- Command (`run_command`, `run_npm`) and git approvals keep their in-chat cards.
- Stop now cancels a pending diff review immediately; enabling ⚡ auto-approve accepts one that is pending.

## 0.4.0 — 2026-10-01

- **Auto provider** — new dropdown mode: tries the last used web provider through Chrome first, then falls back to local Ollama automatically (chat notices when a fallback happens).
- **Status badge** 🟢🟡🔴 next to the provider picker — live Chrome/CDP and Ollama availability; click it for a detailed report.
- **Show Chrome** — new command + 👁 toolbar button: moves the offscreen Chrome window back on screen and focuses it.
- **Show Provider Status** — detailed report (CDP port, DeepSeek login, Ollama models) written to the Freekit output channel and into the chat.
- **Configurable Ollama URL** (`freekit.ollamaUrl`, default `http://localhost:11434`).

## 0.3.0 — 2026-09-30

First commercial-readiness pass (all P0 findings from the audit):

- **Portability** — Chrome/Edge auto-detection on Windows, macOS and Linux; the browser profile moved from the project folder to VS Code global storage; configurable CDP port (`freekit.cdpPort`) and optional binary override (`freekit.chromePath`).
- **Close Browser really closes** the browser now (CDP `Browser.close`, with a hard fallback that kills the PID listening on the CDP port).
- **Security** — extension now requires a trusted workspace; the webview gets a strict CSP; enabling ⚡ auto-approve asks for explicit confirmation.
- **Diagnostics** — new `Freekit: Diagnostics` command plus a dedicated "Freekit" output/log channel for all extension logs.
- **Guardrail** — total time budget per message (`freekit.messageTimeoutMinutes`, default 20 min).
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
