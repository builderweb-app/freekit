# Freekit v2.6.1 — Whole-Codebase Audit Report

**Scope:** `C:\Users\Lanon\ai-bridge` @ v2.6.1 — `src/**` (60 TypeScript files, ~1.4 MB), `package.json`, `tsconfig.json`, `CHANGELOG.md`
**Mode:** Report-only. No source file was modified.
**Method:** clean `tsc` run; mechanical extraction (exports, commands, settings, `catch` blocks, `Promise.all`, timers, `any`) cross-checked against call sites; manual reading of the healer/lock/score subsystem and the response-read path.

---

## Summary

| Severity | Count |
|---|---|
| 🔴 CRITICAL | 1 |
| 🟠 HIGH | 4 |
| 🟡 MEDIUM | 12 |
| ⚪ LOW | 7 |
| ℹ️ INFO | 7 |

Compilation is clean and there are **no** `@ts-ignore` / `@ts-expect-error` suppressions anywhere in `src/`. `strict: true` is on. All 12 audit "critical fixes" from v2.5.2 → v2.6.1 are still present and wired; the problems below are mostly in the *margins* the incremental fixes never revisited.

---

## 🔴 CRITICAL

### C1 — Deprecated setting `freekit.aiSelectorFinder` is declared but never read; silent opt-out reversal

| Field | Value |
|---|---|
| **Area** | 2 (dead config) / 8 (config surface) |
| **Evidence** | Declared: [`package.json`](c:/Users/Lanon/ai-bridge/package.json) → `contributes.configuration.properties["freekit.aiSelectorFinder"]` (`type: boolean`, `default: false`, `deprecationMessage: "Deprecated — use freekit.aiSelectorFinder.mode instead"`, `markdownDescription: "**Deprecated** … **Kept only so older settings files keep working**"`). Read: the only configuration read is [`ai-selector-finder.ts:216`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:216) `.get<string>('aiSelectorFinder.mode', AI_FINDER_DEFAULT_MODE)`; `AI_FINDER_DEFAULT_MODE = 'api-proxy'` at [`ai-selector-finder.ts:200`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:200); the declared default of the mode setting is also `"api-proxy"` (package.json). A full-repo grep for `aiSelectorFinder` finds `.mode` only. |
| **Impact** | An upgrading user who had written `"freekit.aiSelectorFinder": false` — i.e. an **explicit opt-out** of automatic selector repair — gets `mode = 'api-proxy'`, because the legacy key is ignored and the mode default is *enabled*. In `api-proxy` mode the finder POSTs a (truncated) **DOM snapshot of the provider page** to `freekit.aiFinderProxyUrl` ([`ai-selector-finder.ts:1521`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:1521) documents the disabled path that no longer triggers). The deprecation text additionally promises back-compat ("kept only so older settings files keep working") that the code does not implement — worse than a no-op: it reverses the user's intent. |
| **Suggested fix** | Read the legacy boolean once, with the mode setting taking precedence, e.g. in `aiFinderMode()`: if `mode` is unset and `get<boolean>('aiSelectorFinder')` is explicitly set to `false`, return `'off'` and log the migration; then either keep the key documented as honoured or remove it and delete the misleading `markdownDescription`. |
| **Confidence** | 8/10 on the mechanism (verified by exhaustive grep + defaults). Severity depends on how much of the installed base set the legacy key. |

---

## 🟠 HIGH

### H1 — v2.5.74 FIX 5 is half-implemented: `isProviderUnhealthy` / `UNHEALTHY_TTL_MS` are dead, so the recorded "unhealthy" state is never consulted

| Field | Value |
|---|---|
| **Area** | 3 (regression) / 2 (dead code) |
| **Evidence** | Dead predicate: [`providerHealth.ts:139`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:139) `export function isProviderUnhealthy(...)` — 1 reference in the whole repo (its own declaration). Its only consumer would be `UNHEALTHY_TTL_MS` at [`providerHealth.ts:46`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:46) (otherwise unused). The state is nevertheless *written* — [`providerHealth.ts:124`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:124) `recordProviderNoResponse` sets `entry.unhealthyAt = Date.now()` — and *cleared* at [`providerHealth.ts:115`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:115). Writer call site: [`chatView.ts:3599`](c:/Users/Lanon/ai-bridge/src/chatView.ts:3599). The doc comment on the recorder claims: *"ca mesajele următoare să nu-l mai aștepte degeaba"* (so subsequent messages no longer wait for it in vain) — that behaviour does not exist. |
| **Impact** | A provider that has just gone mute (e.g. Qwen on a greeting) is switched away from *for that one message*, but the next message waits the full timeout budget again. The persisted `provider-reliability.json` accumulates `noResponse`/`unhealthyAt` that no code path reads — pure write amplification plus a misleading fixture for anyone debugging. The CHANGELOG advertises this behaviour, so it is a documented-but-absent fix. |
| **Suggested fix** | Either consult it — in the provider-preparation path, skip (or de-prioritise with a chat notice) a provider where `isProviderUnhealthy(root, id)` is true — or, if the immediate switch is deemed sufficient, delete `isProviderUnhealthy`, `UNHEALTHY_TTL_MS`, the `unhealthyAt` field and its writes and correct the CHANGELOG. |
| **Confidence** | 9/10 |

### H2 — `NON_NEWCHAT_LABEL_RE` is an unguarded substring match over the *selector string*, and can auto-unlock + replace a correct user-locked selector (v2.5.44 vs v2.5.72)

| Field | Value |
|---|---|
| **Area** | 4 (contradictory logic) / 7 (duplication) |
| **Evidence** | [`ai-selector-finder.ts:2574`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2574) `const NON_NEWCHAT_LABEL_RE = /retry|regenerate|edit|delete|remove|dismiss|upgrade|cancel|close/i;` applied at [`ai-selector-finder.ts:2591`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2591) to the whole selector text. Registered as the functional validator at [`ai-selector-finder.ts:4282`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:4282) → consumed in [`selectors.ts:2614`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2614) for **user-locked** selectors and [`selectors.ts:2711`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2711) for healer candidates. On failure of a locked selector: [`selectors.ts:2634`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2634) `recordFailure` → after `USER_LOCK_FAILURE_THRESHOLD = 3` ([`selectors.ts:480`](c:/Users/Lanon/ai-bridge/src/selectors.ts:480)) the auto-unlock path runs and hands the slot to the AI finder ([`selectors.ts:2641`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2641)). Contrast the *guarded* blacklist the same project built for exactly these false positives: `authOnlyHit` / `modeOnlyHit` / `tokenOnlyHit` / `noLetterBeforeHit` ([`selectors.ts:300-380`](c:/Users/Lanon/ai-bridge/src/selectors.ts:300)) exist so that `auth≠author`, `earn≠learn`, `light≠highlight`. `NON_NEWCHAT_LABEL_RE` has no such guard, and selector text legitimately contains these tokens (own `id`, own classes, own `aria-label`, or an AI-proposed ancestor path — see `selectorCandidates` at [`selectors.ts:1401`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1401)). |
| **Impact** | False negatives compound: a *correct* user-locked `newChat` selector whose text contains `edit`/`close`/`remove`/… fails the functional test with the (misleading) reason `action label (retry/regenerate/edit/delete)`, is counted as a failure, and after 3 occurrences is removed from `_meta.locked` and **overwritten by the AI** — the exact outcome v2.5.44 was written to prevent. The user's manual repair is silently discarded. |
| **Suggested fix** | Apply the same token guards used everywhere else (test the *element's* label/`aria-label`/text rather than the raw selector string, and require word boundaries — e.g. `(^|[^a-z])(retry|regenerate|edit|delete|remove|dismiss|upgrade|cancel|close)([^a-z]|$)`), or test only the final segment's own attributes. Also fix the rejection log to name the token that actually matched. |
| **Confidence** | 8/10 for the false-negative mechanism; the auto-unlock consequences are verified in code. |

### H3 — `tryReadInfo` reports *every* read failure as "file not found"; `edit_file` then tells the model the file does not exist

| Field | Value |
|---|---|
| **Area** | 5 (silent failure) |
| **Evidence** | [`tools.ts:2208-2221`](c:/Users/Lanon/ai-bridge/src/tools.ts:2208) — `try { … readFile … return {exists:true,…} } catch { return { exists: false, content: '' }; }` with no log and no distinction between "absent", "permission denied", "I/O error" and `safePath`'s *rejected outside allowed roots* ([`tools.ts:2386`](c:/Users/Lanon/ai-bridge/src/tools.ts:2386), which throws for out-of-scope paths). Consumer: [`tools.ts:2009-2016`](c:/Users/Lanon/ai-bridge/src/tools.ts:2009) → `if (!oldInfo.exists) { logLine('tool', 'edit_file failed: file not found: …'); return { ok:false, error: 'File not found: …' } }`. Secondary consumers treat the same flag as truth: [`tools.ts:2620`](c:/Users/Lanon/ai-bridge/src/tools.ts:2620) / [`tools.ts:3676`](c:/Users/Lanon/ai-bridge/src/tools.ts:3676) / [`tools.ts:3922`](c:/Users/Lanon/ai-bridge/src/tools.ts:3922) set `isNew: !oldInfo.exists` for the diff preview. |
| **Impact** | Two distinct harms. (a) The model receives a *false, actionable* diagnosis: it is told a file it can see in the workspace does not exist, so the natural recovery is `write_file` with only the intended fragment — silently truncating the rest of the real file. (b) The native diff pane renders an existing file as `📄 New file: …` (a wrong user-visible state), and an out-of-scope path rejection is masked as "not found", removing the operator's only signal about the behaviour. |
| **Suggested fix** | Have `tryReadInfo` return a discriminated result (`{ ok:true, content } | { ok:false, reason:'missing'|'denied'|'error', detail }`), log non-`missing` reasons at least once, and make `edit_file` emit the real reason; for the preview path, only claim `isNew` on a genuine `ENOENT` (or `FileSystemError.FileNotFound`). |
| **Confidence** | 9/10 |

### H4 — A malformed `.vscode/mcp.json` is swallowed with no log and no user notice

| Field | Value |
|---|---|
| **Area** | 5 (silent failure) |
| **Evidence** | [`mcp/client.ts:286`](c:/Users/Lanon/ai-bridge/src/mcp/client.ts:286) — the `try` reads and `JSON.parse`s the workspace MCP config and logs success (`log('loaded .vscode/mcp.json')`); the `catch` body is the comment `/* fișierul nu există sau nu e JSON valid */` and nothing else. |
| **Impact** | A user with a JSON syntax error (trailing comma, comment) in `.vscode/mcp.json` gets **no MCP tools and no explanation anywhere** — not in Output → Freekit, not in chat. The failure mode is indistinguishable from "no servers configured", which is precisely the class of silent failure the audit targets. Note the sibling path at [`mcp/client.ts:303`](c:/Users/Lanon/ai-bridge/src/mcp/client.ts:303) already has an explicit "no vscode (Node tests)" rationale, so the two catches are not equivalent. |
| **Suggested fix** | Distinguish `ENOENT` from a parse error; on parse error `logLine('mcp', 'invalid .vscode/mcp.json: ' + msg)` and post one chat notice (`post('notice', …)`) so the user knows why their servers are missing. |
| **Confidence** | 9/10 |

---

## 🟡 MEDIUM

### M1 — Healer candidate budget (`slice(0,3)`) is applied *before* the score filter, over a list that is not sorted by score

- **Area** 4 (contradictory logic) / 3 (regression risk)
- **Evidence** [`selectors.ts:2693`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2693) builds `ordered = [...stable, ...usable.filter(isFragileSelector)]` — a *stable-first partition*, so the score-descending order produced by `scanCandidates` ([`selectors.ts:1935`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1935) `shortlist.sort((a,b)=> b.score-a.score)`) is broken at the `stable|fragile` seam. [`selectors.ts:2697`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2697) then does `for (const candidate of ordered.slice(0, HEALER_MAX_FUNCTIONAL_TRIES))` with `HEALER_MAX_FUNCTIONAL_TRIES = 3` ([`selectors.ts:512`](c:/Users/Lanon/ai-bridge/src/selectors.ts:512)), and the score threshold `minHealerScore(slot)` (`MIN_HEALER_SCORE = 10` at [`selectors.ts:521`](c:/Users/Lanon/ai-bridge/src/selectors.ts:521), `NEWCHAT_MIN_SCORE = 25` at [`selectors.ts:529`](c:/Users/Lanon/ai-bridge/src/selectors.ts:529)) is checked *inside* the truncated loop with `continue` ([`selectors.ts:2720`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2720)).
- **Impact** If ≥3 stable candidates exist, a fragile candidate is never examined — even when it is the only one above the threshold. The `continue`s also mean three below-threshold stable candidates can consume the entire budget while a valid candidate sits untested. This weakens the very subsystem (healer scoring/thresholds) that v2.5.61/v2.5.65/v2.5.74 spent three releases tuning, and produces `tier 3 (healer) found no candidate that passed the score/functional test` in a case where one existed.
- **Suggested fix** Filter by score (and `isUsableSelector`/`isPersistBlocked`) *before* partitioning and slicing — e.g. `const eligible = usable.filter(c => c.score >= minHealerScore(slot)); const ordered = [...eligible.filter(notFragile), ...eligible.filter(isFragile)];` and slice that — or sort `ordered` by score after the partition.
- **Confidence** 8/10 on the code shape; probability of hitting it in the field is moderate (fragile candidates usually score low).

### M2 — `HEAL_CHECKPOINTS` contains two entries that can never heal, and the pair contradicts v2.5.61's "repair at the first failure"

- **Area** 4 (contradictory logic) / 9 (log hygiene)
- **Evidence** [`base.ts:41`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:41) `HEAL_CHECKPOINTS = [4000, 9000, 20000, 40000]` versus [`base.ts:1356`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:1356) `const RESPONSE_HEAL_MIN_MS = 20_000`. At [`base.ts:1857-1867`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:1857) any checkpoint below `RESPONSE_HEAL_MIN_MS` only logs `response heal skipped at <ms> (the reply may still be rendering)` ([`base.ts:1864`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:1864)).
- **Impact** Entries `4000` and `9000` are dead as *healing* triggers (their only effect is to advance `healIndex` and emit two log lines on **every** message). A maintainer reading the array will assume four repair opportunities exist. The comment at [`selectors.ts:2654`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2654) ("immediate repair triggered… we do not wait for three") describes the opposite intent of the 20 s gate for this slot.
- **Suggested fix** Express the intent in one place — e.g. `const HEAL_CHECKPOINTS = [RESPONSE_HEAL_MIN_MS, RESPONSE_HEAL_MIN_MS + 20_000]` — or keep the early checkpoints but make them a separate named constant for error detection only, and drop the misleading "skipped" log to a `logDebug`-level line.
- **Confidence** 9/10

### M3 — Provider logs bypass the dedicated Output channel (`console.log` instead of `logLine`)

- **Area** 9 (log hygiene) / 7 (duplication)
- **Evidence** [`base.ts:38`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:38) `const log = (msg: string) => console.log('[Freekit]', msg);` — used by ~57 `log()` calls in that file — while the *same file* imports and uses `logLine` 13 times ([`base.ts:26`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:26)). Same pattern at [`mcp/client.ts:7`](c:/Users/Lanon/ai-bridge/src/mcp/client.ts:7) `console.log('[Freekit][mcp]', msg)`. Every other module correctly uses the channel ([`log.ts:15`](c:/Users/Lanon/ai-bridge/src/log.ts:15) `initLogChannel` / [`log.ts:23`](c:/Users/Lanon/ai-bridge/src/log.ts:23) `logLine`), and `log.ts` even documents "Toate log-urile extensiei trec prin aici".
- **Impact** The most diagnostic-heavy module in the extension — the response-wait loop, healer checkpoints, rescue path, provider detection — is **invisible in Output → Freekit**. Users filing bugs will paste an Output panel that is missing exactly the lines needed; support must fall back to the Developer Tools console. Mixed use inside one file means the channel's completeness is unpredictable.
- **Suggested fix** Delete the two local `console.log` shims and route them through `logLine('provider'|'mcp', …)`; keep the `console.log` inside `logLine` for DevTools parity (already the case at [`log.ts:29`](c:/Users/Lanon/ai-bridge/src/log.ts:29)).
- **Confidence** 10/10

### M4 — On-save indexing is O(n²) in index size: a full index rewrite per saved file

- **Area** 10 (async safety / performance)
- **Evidence** [`extension.ts:789-795`](c:/Users/Lanon/ai-bridge/src/extension.ts:789) loops `for (const f of files) { await indexSingleFile(root, f); }` sequentially; each `indexSingleFile` ends with `await saveIndex(indexFilePath(root), data)` at [`indexer/indexer.ts:494`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:494), and `saveIndex` serialises and rewrites the **entire** index ([`store.ts:83-89`](c:/Users/Lanon/ai-bridge/src/indexer/store.ts:83) `JSON.stringify(data)` → temp + rename). (The full-workspace path is fine — it saves once at [`indexer/indexer.ts:417`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:417).)
- **Impact** Saving 20 files in one debounce window (a refactor, a formatter run, a branch switch) triggers 20 complete index serialisations and 20 full-index reloads, each proportional to the whole vector corpus. Cost grows quadratically with workspace size, and the debounce only coalesces sub-1.5 s bursts.
- **Suggested fix** Add a batch entry point (`indexFiles(root, paths[])`) that loads the index once, indexes all files, and saves once; have the save handler call it instead of looping `indexSingleFile`.
- **Confidence** 9/10

### M5 — Embeddings are computed strictly sequentially, one HTTP round-trip per chunk

- **Area** 10 (async safety / performance)
- **Evidence** [`indexer/indexer.ts:373-388`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:373) (`for (const rc of raw) { … await embedText(…) }`) and the single-file path at [`indexer/indexer.ts:482-488`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:482). Iterations are independent (each vector is written to its own chunk record).
- **Impact** First-time indexing of a repository is latency-bound on Ollama round-trips rather than CPU; a bounded worker pool (`Promise.all` over slices of, say, 4) would cut wall-clock time by roughly that factor. On a large workspace this dominates the `freekit.indexWorkspace` experience.
- **Suggested fix** Process chunks in batches of N with `Promise.all` (or `allSettled` to keep M6's failure accounting), preserving the `opts.signal?.aborted` check between batches.
- **Confidence** 8/10 (sequential is not *incorrect*, just slow; it may be deliberate to avoid overloading a local Ollama — worth confirming intent).

### M6 — Embedding failures silently drop chunks, so the semantic index degrades without a signal

- **Area** 5 (silent failure)
- **Evidence** [`indexer/indexer.ts:373-388`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:373): `if (!vector) { failed++; continue; }` — the chunk is discarded. The failure is only surfaced as a per-file `skipped: 'embedding failed'` **when every chunk failed** ([`indexer/indexer.ts:393-399`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:393) `...(failed && !chunks.length ? { skipped: … } : {})`); with an aggregate counter at [`indexer/indexer.ts:374`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:374) `stats.failed += failed`. Note the general `catch` in `embedText`'s caller path at [`indexer/indexer.ts:336`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:336) also swallows with only `skipFile('unreadable')`.
- **Impact** A partially-failed index looks healthy: `search_semantic` returns results that are silently missing whole files/sections. The only witness is a stats counter the user has to go looking for. Root cause (Ollama down, model not pulled, timeout) is never logged with context.
- **Suggested fix** Log once per run at `logWarnLine('indexer', …)` with the first failure reason and the count, and surface it in `freekit.indexStatus`; consider retrying once before dropping a chunk.
- **Confidence** 9/10

### M7 — Duplicated regex constants that can drift

- **Area** 7 (duplication)
- **Evidence** `MSG_ID_RE` declared twice — [`chatView.ts:525`](c:/Users/Lanon/ai-bridge/src/chatView.ts:525) and [`verifier.ts:567`](c:/Users/Lanon/ai-bridge/src/verifier.ts:567), both `/^[A-Za-z0-9_-]{1,64}$/`. `GIT_HASH_RE` declared twice — [`tools.ts:4287`](c:/Users/Lanon/ai-bridge/src/tools.ts:4287) and [`verifier.ts:568`](c:/Users/Lanon/ai-bridge/src/verifier.ts:568). `FILE_TARGET_RE` ([`chatView.ts:212`](c:/Users/Lanon/ai-bridge/src/chatView.ts:212)) inlines an extension list that also exists in `attachments.ts:44` and `selectors.ts`' scope regexes.
- **Impact** Message-ID/hash validation is a trust boundary (the webview `messageId` is echoed back into checkpoint/rollback flows). Two copies of the same pattern that encode a security-relevant bound (`{1,64}`) will eventually diverge, and the divergence is invisible until someone widens one side.
- **Suggested fix** Move to a shared `src/patterns.ts` (or reuse the one in `verifier.ts`) and import in both.
- **Confidence** 10/10 on the duplication (values are currently identical, so no live bug).

### M8 — `toAiFileHeader` is dead while the header/note format it defines is re-implemented inline in ≥6 places

- **Area** 2 (dead code) / 7 (duplication) / 3 (v2.5.27)
- **Evidence** Dead export [`tsAlias.ts:63`](c:/Users/Lanon/ai-bridge/src/tsAlias.ts:63) `export function toAiFileHeader(p: string)` — zero references. The same `'--- FILE: ' + alias + ' ---'` + `TS_ALIAS_NOTE` shape is hand-built at [`tools.ts:2451`](c:/Users/Lanon/ai-bridge/src/tools.ts:2451), [`tools.ts:3590`](c:/Users/Lanon/ai-bridge/src/tools.ts:3590), [`chatRotation.ts:229`](c:/Users/Lanon/ai-bridge/src/chatRotation.ts:229), and a variant without the alias at [`attachments.ts:151/157/166/180`](c:/Users/Lanon/ai-bridge/src/attachments.ts:151). `TS_ALIAS_NOTE` itself is imported in four files and used in three.
- **Impact** The v2.5.27 fix (`.ts` sent as `.ts.txt` + explanatory note) is currently correct at every site I checked, but the invariant "every AI-visible TS file header carries the alias note" is enforced by copy-paste in at least six places. Adding a seventh path (or changing the note) will silently produce a header the model cannot interpret, and the one function written to centralise it is unused.
- **Suggested fix** Delete `toAiFileHeader` or — better — actually use it at the five TS-carrying sites and keep one binding-writing point.
- **Confidence** 9/10

### M9 — Four overlapping `newChat` rejection mechanisms with divergent token sets

- **Area** 4 (contradictory logic) / 7 (duplication)
- **Evidence** `NON_ACTION_RE` ([`ai-selector-finder.ts:86`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:86), word-boundaried: sign/login/upgrade/premium/invite/subscribe/purchase/checkout/download); `NON_NEWCHAT_LABEL_RE` ([`ai-selector-finder.ts:2574`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2574), unguarded: retry/regenerate/edit/delete/remove/dismiss/upgrade/cancel/close); `NEWCHAT_CHROME_TOKENS` ([`selectors.ts:1297`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1297): dismiss/close/upgrade/cancel, −20); the action-token list at [`selectors.ts:1854-1871`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1854) (copy/edit/delete/retry/regenerate/share/download/feedback/thumbs/action-bar/message-actions/rename/archive/hide/mute, −50) plus `CHAT_ITEM_ACTIONS` at [`selectors.ts:1285`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1285) (−40) and the −6 list at [`selectors.ts:1780`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1780).
- **Impact** The same token is penalised up to three times on one element (`edit` → −6, −40, −50) while `upgrade`/`dismiss` are handled by three different mechanisms with three different match semantics (word-boundary vs substring). Adding a token to one list has an unpredictable, order-dependent effect on the total score, which is exactly the kind of coupling that produced the `action-bar-copy` (score 23) and `Dismiss upgrade banner` bugs. The sets can and will diverge (they already do: `remove` exists only in one).
- **Suggested fix** Collapse to one declarative table (token → weight → guard kind) exported from a single module and passed into the page-serialised function as an argument (the existing `blacklist`/`promoText`/`navSels` pattern at [`selectors.ts:2674`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2674) already shows how).
- **Confidence** 9/10

### M10 — Silent locator-resolution failures hide permanently broken selectors

- **Area** 5 (silent failure)
- **Evidence** [`selectors.ts:2805-2808`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2805) `} catch { /* selector invalid sau pagină în tranziție — încercăm următorul */ }` and [`selectors.ts:2819-2824`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2819) `} catch { /* continuăm */ }` — no log in either.
- **Impact** An invalid-CSS selector (a typo'd user lock, a stale learned selector) and a transient page state are indistinguishable in the log; the operator sees only the downstream `recordFailure` counters and cannot tell whether the selector is *malformed* or merely *absent*. This lengthens diagnosis of the most common support issue in the extension.
- **Suggested fix** Log the selector text and the error message for at least the first failure per slot per session.
- **Confidence** 9/10

### M11 — 16 dead exported symbols (one of them a described-but-missing behaviour)

- **Area** 2 (dead code)
- **Evidence** Verified by reference-counting every `export function|const|class` in `src/**` (504 total): each of the following has precisely **1** reference — its own declaration.

  | Symbol | Location |
  |---|---|
  | `extractSelectorFromProxyResponse` | [`ai-selector-finder.ts:1065`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:1065) |
  | `resetAIFinderCache` | [`ai-selector-finder.ts:3487`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:3487) |
  | `discoveryDateFor` | [`ai-selector-finder.ts:3855`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:3855) |
  | `resetDiscoveryState` | [`ai-selector-finder.ts:3860`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:3860) |
  | `tierCapacityGb` | [`hardware.ts:401`](c:/Users/Lanon/ai-bridge/src/hardware.ts:401) |
  | `humanTypingEnabled` | [`human-behavior.ts:310`](c:/Users/Lanon/ai-bridge/src/human-behavior.ts:310) |
  | `getAvailableModels` | [`modelSelector.ts:396`](c:/Users/Lanon/ai-bridge/src/modelSelector.ts:396) |
  | `popupIntent` | [`popups.ts:100`](c:/Users/Lanon/ai-bridge/src/popups.ts:100) |
  | `isProviderUnhealthy` | [`providerHealth.ts:139`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:139) → see **H1** |
  | `malformedRate` | [`providerHealth.ts:161`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:161) |
  | `proactiveDiscovery` | [`selectors.ts:2579`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2579) |
  | `extractCodeFences` | [`tools.ts:1169`](c:/Users/Lanon/ai-bridge/src/tools.ts:1169) |
  | `isPathInsideRoot` | [`tools.ts:2358`](c:/Users/Lanon/ai-bridge/src/tools.ts:2358) |
  | `workspaceRoots` | [`tools.ts:2426`](c:/Users/Lanon/ai-bridge/src/tools.ts:2426) |
  | `isTsAliasPath` | [`tsAlias.ts:45`](c:/Users/Lanon/ai-bridge/src/tsAlias.ts:45) |
  | `toAiFileHeader` | [`tsAlias.ts:63`](c:/Users/Lanon/ai-bridge/src/tsAlias.ts:63) |

  Two are *behavioural* rather than cosmetic: `malformedRate` ([`providerHealth.ts:161`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:161)) is documented as the input to the ">20 % → suggest switch" rule, but the rule is re-implemented inline instead ([`chatView.ts:4126-4132`](c:/Users/Lanon/ai-bridge/src/chatView.ts:4126) `const rate = entry.malformed / total`); `proactiveDiscovery()` ([`selectors.ts:2579`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2579)) is an accessor for `proactiveDiscoveryFn`, which *is* registered and *is* called elsewhere — the accessor is simply never used. `humanTypingEnabled` duplicates `humanSettings().typing`, which callers use directly ([`base.ts:1457`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:1457)). `isPathInsideRoot` appears superseded by `isInsideRoot` ([`tools.ts:2396`](c:/Users/Lanon/ai-bridge/src/tools.ts:2396)).
- **Impact** Indicates the abstractions were written slightly ahead of (or behind) their call sites; `malformedRate` in particular guarantees that the threshold logic exists in two places that can drift.
- **Suggested fix** Delete the unused exports or route callers through them (prefer the latter for `malformedRate`). `deactivate` ([`extension.ts:849`](c:/Users/Lanon/ai-bridge/src/extension.ts:849)) is **not** in this list — it is referenced only by name because VS Code invokes it as the host lifecycle hook; it must stay exported.
- **Confidence** 9/10 (reference-counted; residual risk of dynamic invocation is low for these names — none appear in `package.json` or `media/`).

### M12 — Type escapes: 290 `any` occurrences, 174 of them `catch (e: any)`, which disables the compiler's catch-variable protection

- **Area** 6 (type safety)
- **Evidence** `strict: true` is set ([`tsconfig.json`](c:/Users/Lanon/ai-bridge/tsconfig.json)), which implies `useUnknownInCatchVariables: true` — yet 174 catch clauses explicitly annotate `catch (e: any)` (counted by regex over `src/**/*.ts`), defeating it. The remaining `any`s cluster at genuine boundaries and are largely defensible: JSON parsing helpers in [`toolCallParser.ts:693-1259`](c:/Users/Lanon/ai-bridge/src/toolCallParser.ts:693) (8 sites), webview message boundary [`chatView.ts:1392`](c:/Users/Lanon/ai-bridge/src/chatView.ts:1392) `handleMessage(msg: any)`, CDP/`window` shims [`browser.ts:237,253,256`](c:/Users/Lanon/ai-bridge/src/browser.ts:237), page-serialised functions [`selectors.ts:1257`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1257), persistence readers [`providerHealth.ts:64-69`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:64), [`ai-selector-finder.ts:2810-3286`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2810).
  Three are **load-bearing** because they consume data the extension does not control: `const BUNDLED_CONFIG = rawConfig as unknown as SelectorConfig` ([`selectors.ts:117`](c:/Users/Lanon/ai-bridge/src/selectors.ts:117)) — an unchecked cast of `selectors.json`; `normalizeFingerprint(raw: any)` / `normalizeRemoteConfig(raw: any)` ([`remoteSelectors.ts:75,98,134`](c:/Users/Lanon/ai-bridge/src/remoteSelectors.ts:75)) — the remote/`selectorsUrl` config path; and `parseUserJson(raw): any` + `Object.entries<any>(payload)` over the user-editable `selectors-user.json` ([`ai-selector-finder.ts:3087,3270,3286`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:3087)).
- **Impact** No `@ts-ignore`/`@ts-expect-error` anywhere (good). The `catch (e: any)` habit is mostly harmless *because* nearly every site immediately does `e?.message ?? String(e)`, but it means the compiler cannot flag a future `e` misuse. The three load-bearing casts mean a malformed `selectors.json`, a hostile/wrong remote config, or a hand-edited `selectors-user.json` reaches the healer as a structurally-unvalidated object and fails at an unpredictable depth. Additionally `noUnusedLocals` / `noUnusedParameters` are **not** enabled, which is why M11's dead code accumulated unnoticed.
- **Suggested fix** Drop the `: any` on catch clauses (the existing `e?.message ?? String(e)` bodies keep working with `unknown` under `strict`); add a runtime shape check (not just a cast) in `normalizeRemoteConfig`/`normalizeFingerprint` and in `init()`'s override loop; enable `noUnusedLocals` (+ `noUnusedParameters`) to surface M11 automatically.
- **Confidence** 10/10 on the counts; 8/10 on the load-bearing classification.

---

## ⚪ LOW

### L1 — Fire-and-forget `setTimeout` with no handle in the AI-finder status path
[`chatView.ts:1007`](c:/Users/Lanon/ai-bridge/src/chatView.ts:1007) schedules a 5 s cleanup without storing the handle, so it cannot be cancelled on view disposal. Impact is negligible (the callback only mutates `aiFinderStatuses`, itself pruned at `> 8` entries at [`chatView.ts:1000`](c:/Users/Lanon/ai-bridge/src/chatView.ts:1000)), but it is the one timer in the codebase that is not tracked — every other timer is stored and cleared (see I3). *Fix:* store the handle and clear it in the view's `dispose`.

### L2 — "heal" is logged before the candidate is classified as a fallback
[`selectors.ts:2724`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2724) emits `heal <provider>.<slot> -> <selector> (scor N | …)` **before** the `isFragileSelector` branch that may store it as a *fragile fallback* instead ([`selectors.ts:2740-2746`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2740), which then logs `keeping fragile fallback …` at [`selectors.ts:2743`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2743)). *Impact:* an operator grepping `heal ` sees a repair where only a fallback was kept. *Fix:* emit the "heal" line only on the `learn()` branch.

### L3 — Misleading rejection reason text
[`ai-selector-finder.ts:2592`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2592) logs `action label (retry/regenerate/edit/delete)` but `NON_NEWCHAT_LABEL_RE` also matches `remove|dismiss|upgrade|cancel|close`. Combined with H2 this sends diagnosis in the wrong direction. *Fix:* log the matched token (make the regex a `match` rather than `test`).

### L4 — "selector repaired" is logged for selectors that merely worked
[`selectors.ts:944`](c:/Users/Lanon/ai-bridge/src/selectors.ts:944) logs `selector repaired: … (how)` from `learn()`, which is also reached from `note()` ([`selectors.ts:880`](c:/Users/Lanon/ai-bridge/src/selectors.ts:880)) — i.e. for a selector that was already working, not repaired. *Impact:* inflates apparent repair activity in the log. *Fix:* log `selector noted` when `how` comes from `note()`.

### L5 — Unbounded in-memory log dedup set
[`tsAlias.ts`](c:/Users/Lanon/ai-bridge/src/tsAlias.ts) (`loggedMessages`) and `pendingLogs` grow for the session with one entry per unique alias mapping; drained by `drainAliasLogs()` ([`chatView.ts:7012`](c:/Users/Lanon/ai-bridge/src/chatView.ts:7012)) but `loggedMessages` is never pruned. Negligible memory, no cap. *Fix:* cap the set size or key it on the file rather than the full message.

### L6 — Redundant persistence of stat fields nothing reads
Overlaps **H1**: [`providerHealth.ts:124-137`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:124) performs a read-modify-write of `provider-reliability.json` on every no-response, for `noResponse`/`unhealthyAt` fields that no code path consults.

### L7 — No `log` on the "fragile fallback kept" path for non-newChat slots
[`selectors.ts:2740-2746`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2740) logs the fallback decision, but the equivalent "candidate rejected for score" path logs via `healLog` ([`selectors.ts:2702`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2702)) while "candidate rejected for functional test" logs via `healLog` too ([`selectors.ts:2720`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2720)) — the two use different channels from the surrounding `log()` calls, so a single failure sequence appears split across two sinks. *Fix:* pick one channel per subsystem.

---

## ℹ️ INFO

- **I1 — Audit-prompt premises corrected.** `NON_NEWCHAT_LABEL_RE` is **not** in `selectors.ts`; it lives at [`ai-selector-finder.ts:2574`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2574), and its comment attributes it to **v2.5.74**, not v2.6.1 (there is no second definition anywhere). The six `freekit.unlockBrokenSelectors<Provider>` commands are **not** dead: they are registered dynamically as `'freekit.unlockBrokenSelectors' + suffix` at [`extension.ts:537`](c:/Users/Lanon/ai-bridge/src/extension.ts:537). `freekit.openBrowser` ([`extension.ts:333`](c:/Users/Lanon/ai-bridge/src/extension.ts:333)) is deliberately absent from `contributes.commands` — a documented hidden back-compat alias (comment at `extension.ts:327`). The `content-length` hit in a settings grep is an HTTP header ([`stt.ts:234`](c:/Users/Lanon/ai-bridge/src/stt.ts:234)), not a configuration key.
- **I2 — No unreachable `else if (!X)` branches.** A whole-`src` scan for `else if (!…)` after a positive test yields exactly one hit, [`chatView.ts:3188`](c:/Users/Lanon/ai-bridge/src/chatView.ts:3188) (`else if (!ts6059TemplateInjected)`), which sits under a genuinely different condition (`rewritten` being falsy) and is reachable.
- **I3 — Timers are all correctly managed.** Only two `setInterval`s exist ([`reporting.ts:586,591`](c:/Users/Lanon/ai-bridge/src/reporting.ts:586)), both stored in `this.timers` and cleared in `dispose()` ([`reporting.ts:737-741`](c:/Users/Lanon/ai-bridge/src/reporting.ts:737)). `Promise.race` timeouts are cleaned in `finally` at [`ai-selector-finder.ts:1196`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:1196), [`ai-selector-finder.ts:1450`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:1450) and [`proxyAi.ts:222`](c:/Users/Lanon/ai-bridge/src/proxyAi.ts:222); `this.hideTimer`, `this.reloadTimer` and `saveTimer` are all stored and cleared. The only untracked timer is L1.
- **I4 — `Promise.all` risk is low.** Only two call sites exist — [`base.ts:293`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:293) and [`hardware.ts:540`](c:/Users/Lanon/ai-bridge/src/hardware.ts:540) — and both sit inside functions whose callers have `catch`/fallback handling. Neither is over best-effort independent work.
- **I5 — Config surface is otherwise clean.** 47 declared properties; 46 are read somewhere; no setting is read without being declared (`content-length` is a false positive). `freekit.aiSelectorFinder` (C1) is the single orphan.
- **I6 — Compiler posture.** `tsc -p ./` exits 0 with no diagnostics; `strict: true`, `skipLibCheck: true`, no suppression comments. `noUnusedLocals`/`noUnusedParameters` are off (see M12).
- **I7 — Over-exported internals.** `AI_FINDER_MAX_ATTEMPTS`, `MAX_PROACTIVE_ATTEMPTS`, `MAX_INPUT_REPAIR_FAILURES`, `INTERACTIVE_FILTER`, `DOM_MAX_CHARS`, `DEFAULT_AI_FINDER_TIMEOUT_SECONDS` (all [`ai-selector-finder.ts:96-174`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:96)) and `AI_FINDER_DEFAULT_MODE` ([`ai-selector-finder.ts:200`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:200)) are `export`ed but referenced only inside their own file. Not dead, but they widen the module's public surface for no reason.

---

## Area 1 — Compilation health

`npm run compile` (`tsc -p ./`) → **exit code 0, no output**. No errors, no warnings. `tsc` emits no warnings by default and none of the strict-family flags that would warn (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`) are enabled, so the clean run should be read as "type-checks", not "clean". Suppression scan: `ts-ignore|ts-expect-error` → **0 matches** in `src/**`.

---

## Area 3 — Regression detection (12 critical fixes)

Every fix below was located and its call chain followed up to a live entry point (command handler, provider method, or the response-wait loop).

| # | Version — fix | Implementation | Verdict |
|---|---|---|---|
| 1 | v2.5.2 — content in code fence | `stripWrappingFence` / `normalizeContentNewlines` chain, [`toolCallParser.ts:1042`](c:/Users/Lanon/ai-bridge/src/toolCallParser.ts:1042); `AI_OPEN_FENCE_RE`/`AI_CLOSE_FENCE_RE` [`tools.ts:2499-2502`](c:/Users/Lanon/ai-bridge/src/tools.ts:2499); exact-one-fence rule [`directWrite.ts:69`](c:/Users/Lanon/ai-bridge/src/directWrite.ts:69) | PRESENT + WIRED |
| 2 | v2.5.4 — strip UI artifacts (astro/Copy/Download) | `stripUiArtifacts` [`toolCallParser.ts:994`](c:/Users/Lanon/ai-bridge/src/toolCallParser.ts:994), applied at [`toolCallParser.ts:1042`](c:/Users/Lanon/ai-bridge/src/toolCallParser.ts:1042) | PRESENT + WIRED |
| 3 | v2.5.10 — single browser conversation per chat | `BrowserChatRef` [`conversations.ts:30`](c:/Users/Lanon/ai-bridge/src/conversations.ts:30); read on resume [`chatView.ts:4011`](c:/Users/Lanon/ai-bridge/src/chatView.ts:4011), written [`chatView.ts:4087`](c:/Users/Lanon/ai-bridge/src/chatView.ts:4087), cleared on new chat [`chatView.ts:5745`](c:/Users/Lanon/ai-bridge/src/chatView.ts:5745) | PRESENT + WIRED |
| 4 | v2.5.20 — don't heal response slot before reply | `RESPONSE_HEAL_MIN_MS` gate + skip log [`base.ts:1860-1866`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:1860); `sawNewResponse` sentinel [`base.ts:1704`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:1704) | PRESENT + WIRED (see M2) |
| 5 | v2.5.27 — `.ts` sent as `.txt` | `toAiPath`/`TS_ALIAS_NOTE` at [`tools.ts:2445`](c:/Users/Lanon/ai-bridge/src/tools.ts:2445), [`chatRotation.ts:227`](c:/Users/Lanon/ai-bridge/src/chatRotation.ts:227); reverse mapping `mapToolCallAliases` [`toolCallParser.ts:1148`](c:/Users/Lanon/ai-bridge/src/toolCallParser.ts:1148); UI de-aliasing [`chatView.ts:3062`](c:/Users/Lanon/ai-bridge/src/chatView.ts:3062) | PRESENT + WIRED — but see M8 |
| 6 | v2.5.39 — recover malformed tool calls | `MAX_MALFORMED_RETRIES`/`classifyMalformedAttempt`/`malformedRetryNudge` retry loop [`chatView.ts:2749-2860`](c:/Users/Lanon/ai-bridge/src/chatView.ts:2749) | PRESENT + WIRED |
| 7 | v2.5.44 — user-locked selectors never overwritten | `existing?.locked` guards in `learn()` [`selectors.ts:905`](c:/Users/Lanon/ai-bridge/src/selectors.ts:905), `forget()` [`selectors.ts:994`](c:/Users/Lanon/ai-bridge/src/selectors.ts:994), `init()` [`selectors.ts:576`](c:/Users/Lanon/ai-bridge/src/selectors.ts:576) | PRESENT + WIRED — but undermined by H2 |
| 8 | v2.5.47 — response selector validated on content | `validateResponseSelector` [`ai-selector-finder.ts:2365`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2365) ← `functionallyValidateSlot` [`ai-selector-finder.ts:2633`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2633) ← registered [`ai-selector-finder.ts:4282`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:4282) ← called [`selectors.ts:2711`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2711) | PRESENT + WIRED |
| 9 | v2.5.56 — auto-switch provider at 3× malformed | `tryAutoSwitchProvider` [`chatView.ts:4146`](c:/Users/Lanon/ai-bridge/src/chatView.ts:4146), invoked from the malformed branch that records the failure at [`chatView.ts:2822`](c:/Users/Lanon/ai-bridge/src/chatView.ts:2822) | PRESENT + WIRED |
| 10 | v2.5.71 — prompt classification | `classifyPrompt` [`chatView.ts:235`](c:/Users/Lanon/ai-bridge/src/chatView.ts:235), called once per message [`chatView.ts:2057`](c:/Users/Lanon/ai-bridge/src/chatView.ts:2057) | PRESENT + WIRED |
| 11 | v2.6.0 — question without a folder | task-only gate [`chatView.ts:2088`](c:/Users/Lanon/ai-bridge/src/chatView.ts:2088), no-folder question path [`chatView.ts:3561`](c:/Users/Lanon/ai-bridge/src/chatView.ts:3561) | PRESENT + WIRED |
| 12 | v2.6.1 — proxy truncation retry | `isTruncatedJsonReply` [`proxyAi.ts:114`](c:/Users/Lanon/ai-bridge/src/proxyAi.ts:114) + retry loop over `PROXY_MAX_ATTEMPTS = 3` [`proxyAi.ts:245-273`](c:/Users/Lanon/ai-bridge/src/proxyAi.ts:245) | PRESENT + WIRED |

**No fix is documented-but-missing.** One documented behaviour is only half-present: v2.5.74 FIX 5's "don't keep waiting for a known-mute provider" — see **H1**.

---

## Area 5 — Silent-failure inventory

Mechanical scan (brace-matched bodies, excluding any body containing a log/notice/throw token): **270 of 423 catch blocks have no logging and no user-visible signal.** Of those, ~42 guard operations the audit ranks as high-value; after manual review the reportable ones are H3, H4, M6, M10 plus these benign-by-design groups:

- Best-effort teardown / detach: [`browser.ts:795,819`](c:/Users/Lanon/ai-bridge/src/browser.ts:795), `page.close()`/`hideOffscreen()` sites.
- Playwright cleanup: clear-composer [`base.ts:226`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:226), attribute scrub [`base.ts:2184`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:2184).
- Node-test-only paths with explicit comments: [`mcp/client.ts:303`](c:/Users/Lanon/ai-bridge/src/mcp/client.ts:303), [`mcp/manager.ts:352`](c:/Users/Lanon/ai-bridge/src/mcp/manager.ts:352), [`log.ts:26`](c:/Users/Lanon/ai-bridge/src/log.ts:26).
- Tolerant parse ladders whose caller retries: [`toolCallParser.ts:699`](c:/Users/Lanon/ai-bridge/src/toolCallParser.ts:699), [`ai-selector-finder.ts:953,996,2813,2818`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:953).
- Existence probes: [`ollama.ts:73,118,440,470`](c:/Users/Lanon/ai-bridge/src/providers/ollama.ts:73), [`browser.ts:333,345`](c:/Users/Lanon/ai-bridge/src/browser.ts:333).
- Optional-telemetry/`stat` failures: [`mcp/manager.ts:525`](c:/Users/Lanon/ai-bridge/src/mcp/manager.ts:525), [`indexer/indexer.ts:131`](c:/Users/Lanon/ai-bridge/src/indexer/indexer.ts:131).
- Proxy SSE fragments: [`proxyAi.ts:89,99`](c:/Users/Lanon/ai-bridge/src/proxyAi.ts:89) — acceptable *because* v2.6.1 added the truncation retry above them.

One flagged-by-scan case is a **false positive**: [`tools.ts:3735`](c:/Users/Lanon/ai-bridge/src/tools.ts:3735) returns a partial-write error string to the model, so the failure is user-visible.

---

## Area 7 — Duplicated logic (beyond M7/M8/M9)

- **Intentional duplication (do not "fix"):** the token guards `authOnlyHit`/`modeOnlyHit`/`tokenOnlyHit`/`noLetterBeforeHit` exist in Node form ([`selectors.ts:300-380`](c:/Users/Lanon/ai-bridge/src/selectors.ts:300)) and again inline as `kwHit` in the page-serialised `scanCandidates` ([`selectors.ts:1317-1350`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1317)). This is required (function is serialised into the browser), and the two copies are currently **in sync** — flagging only as a standing drift risk, since nothing enforces equality.
- **`malformedRate` vs inline rate:** [`providerHealth.ts:161`](c:/Users/Lanon/ai-bridge/src/providerHealth.ts:161) vs [`chatView.ts:4126`](c:/Users/Lanon/ai-bridge/src/chatView.ts:4126) — same formula, two sites (M11).
- **`humanTypingEnabled` vs `humanSettings().typing`** (M11).
- **`toAiFileHeader` vs five inline headers** (M8).
- **`isPathInsideRoot` vs `isInsideRoot`** (M11) — same concept, two names, one unused; scope-checking for the tool sandbox originates at [`tools.ts:2386`](c:/Users/Lanon/ai-bridge/src/tools.ts:2386).
- **`heal*` family:** `healSlot` is the single orchestrator ([`selectors.ts:2607`](c:/Users/Lanon/ai-bridge/src/selectors.ts:2607)) with `functionallyValidateSlot` ([`ai-selector-finder.ts:2633`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:2633)) as the validator — no duplicate orchestrators, but the *scoring* logic is split between `scanCandidates`'s inline `score()` ([`selectors.ts:1532`](c:/Users/Lanon/ai-bridge/src/selectors.ts:1532)) and the fingerprint-based validator, which is why M1/M9 are easy to get wrong.
- **`detect*` family:** `detectProviderError` ([`providerErrors.ts`](c:/Users/Lanon/ai-bridge/src/providerErrors.ts)) and `detectProviderErrorOnPage` ([`base.ts:806`](c:/Users/Lanon/ai-bridge/src/providers/base.ts:806)) are correctly layered (page-level delegates to text-level), not duplicated.

---

## Area 10 — Async safety (summary)

Timers: clean (I3). `Promise.all`: low risk (I4). Awaits in loops: 20+ sites, most legitimately sequential (polling with `sleep`, candidate probing with early return, recursive directory walk); the two that matter are **M4** (sequential `indexSingleFile` × per-file full index rewrite) and **M5** (sequential `embedText`). No un-awaited critical promises found beyond the deliberate `work.catch(() => undefined)` race-losers at [`ai-selector-finder.ts:1179`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:1179) and [`ai-selector-finder.ts:1393`](c:/Users/Lanon/ai-bridge/src/ai-selector-finder.ts:1393), which are correctly handled (v2.5.17 fix) — the sibling timeout promises are cleared in `finally`.

---

## Notes for the next pass

1. **H1 and M11 overlap** — resolving `isProviderUnhealthy` decides the fate of `UNHEALTHY_TTL_MS` and the `unhealthyAt` writes.
2. **H2 and M9 share a root cause** — scattered, differently-guarded token lists. One declarative table fixes both and prevents the next `Dismiss upgrade banner`.
3. **Enabling `noUnusedLocals`** would have caught most of M11 mechanically; it is the single highest-leverage config change here.
4. **M4/M5** are the only findings with a monotonic cost: they get worse as workspaces (and the shared `provider-reliability.json`) grow.
5. The healer subsystem (`selectors.ts` + `ai-selector-finder.ts`) carries the highest density of accumulated conditional logic in the codebase: H2, M1, M9 and M10 all live there. The token-table refactor plus the score-filter/slice ordering fix should land before any further threshold tuning, otherwise the next "one more penalty" fix will re-introduce the same class of bug.
