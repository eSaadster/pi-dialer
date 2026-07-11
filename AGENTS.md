# AGENTS.md

Guidance for AI agents working in **pi-dialer** — a [pi](https://github.com/earendil-works)
extension that routes each prompt to a pre-configured model + thinking level based on the task
type it detects (plan / implement / deep-dive / quick-edit / custom). See `README.md` for
user-facing behavior.

## Commands

- `npm run check` — type-check (`tsc --noEmit`). **There is no build step**: pi loads the TypeScript
  directly via [jiti](https://github.com/unjs/jiti). `npm run build` is intentionally a no-op echo.
- `npm test` — runs every `src/__tests__/*.test.ts`. The runner is a tiny custom harness
  (`src/__tests__/_harness.ts` exports `test`/`eq`/`fakeModel`); there is no jest/vitest.
- Run a single suite: `node --import jiti/register src/__tests__/<name>.test.ts`.
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` — stricter pass; catches dead
  imports/locals that `npm run check` won't. Run it before finishing a change.
- `npm pack --dry-run` — verify the published tarball (the `files` glob is `src/*.ts` + docs; it is
  **non-recursive**, so `src/__tests__/` and `docs/` are correctly excluded).
- Try it live in pi: `pi -e .` (or `pi install /abs/path`), then `/reload` after edits.
- **Requires Node ≥ 22.19.0** (the `@earendil-works/pi-*` peers need it). CI runs Node 22.

## Architecture (the parts that span files)

**Extension shape.** `src/index.ts` `export default function (pi: ExtensionAPI)` is the entry
point. It registers the virtual **dialer provider/model**, the `/dialer*` commands, and the
lifecycle handlers (`input`, `model_select`, `session_start`/`session_tree`). Everything is wired
against pi's peer packages — `@earendil-works/pi-ai` (model/message types,
`createAssistantMessageEventStream`), `pi-coding-agent` (`ExtensionAPI`/`ExtensionContext`,
`ModelRegistry`), and `pi-tui` (TUI components). **Verify any pi API against its installed
`.d.ts` before using it** — much of it is typed-only and not in the written docs.

**The virtual model.** `pi.registerProvider("dialer", …)` adds a fake `dialer/pi-dialer` model so
"Pi Dialer" appears in pi's model picker. While the dialer is on, the virtual model stays
**selected between prompts** so pi's built-in footer reads `pi-dialer` bottom-right
(`reasoning: false` suppresses the thinking-level suffix): routing switches to the real model for
the run, and `agent_end` parks back via `parkOnDialer`. It must never stream: routing falls back
through `fallbackRealModel` (default route model → last real model → any authed text model) and
blocks the prompt if nothing resolves; `streamSimple` returns an error stream as a
belt-and-suspenders if it is ever invoked. A `selfSwitch` flag distinguishes the extension's own
`setModel` calls from manual user selection (which turns the dialer off); `model_select` with
`source === "restore"` never turns it off. **Compaction**: pi summarizes with the *selected*
model and captures its auth before `session_before_compact` fires, so while parked the extension
must produce the `CompactionResult` itself (`dialerCompaction` + the top-level `compact` export
from pi-coding-agent, against `fallbackRealModel`); switching models inside the handler would
run with the virtual model's fake auth. Failures cancel with a notify — falling through would
re-run against the unstreamable virtual model.

**Routing.** `pi.on("input")` (skipping `/`-commands, `!`-bash, and extension-sourced input)
classifies the prompt via `classify.ts` `classifyPrompt` — a pure keyword scorer (phrase word
count = weight, ties keep the earliest resolved route) — then applies the winning route's
`model`/`thinking` via `pi.setModel`/`pi.setThinkingLevel` before the agent loop starts. Failure
to resolve/auth a model degrades gracefully (warn + keep the current model); a prompt is only
blocked (`action: "handled"`) if the virtual dialer model would otherwise stream.

**Response stamp.** The input handler stashes the routing decision in `pendingNote`; the
`message_end` handler appends `formatRouteFooter(note)` to the final assistant message's last text
block (skipping `stopReason === "toolUse"` intermediates) and clears the note, with an `agent_end`
backstop so a stale note never leaks onto a later unrouted response. Same append pattern as the
user's global pi-read-coverage extension.

**Config + precedence.** `config.ts` `loadConfig` reads project `.pi/dialer.json` (trusted
projects only) then global `~/.pi/agent/dialer.json`; the first file found wins whole (no
merging between files). Within a config, `effectiveSetup` picks the active named setup's routes
(`setups`/`activeSetup`; unknown active setup warns and falls back to top-level `routes`).
`resolveRoutes` merges those routes with the built-ins: config routes first in file order (this
is the tie-break order), then unmentioned built-ins, `default` always last with no keywords.
Route `keywords` **replace** the built-in list for that task. `/dialer-setup`, `/dialer use`, and
`/dialer save` edit the **global** file only (`mergeRouteSelections` targets the active setup and
preserves keywords/unknown routes; `use none` deactivates — "none" is a reserved setup name); a
project file still overrides at routing time.

**Session state.** There is no key/value store: on/off state is appended as custom session
entries via `pi.appendEntry("dialer-state", …)` and read back by scanning
`ctx.sessionManager.getBranch()` (`restoreState`), restored on `session_start`/`session_tree`.
The footer chip comes from `ctx.ui.setStatus("dialer", …)`.

**Setup UI.** `src/ui.ts` `selectDialerSetup` is a custom `ctx.ui.custom` TUI: a task-row list
(model + thinking per task) with a model-picker sub-mode (`/` search). The pure helpers
(`cycleThinking`, `thinkingLabel`, `rowModelLabel`) are exported and unit-tested; the TUI
rendering is not.

## Conventions & gotchas

- **Documented pi-API workarounds live in `docs/pi-api-notes.md`** and carry `// pi gap:` comments
  at each site (e.g. `setSelectListItems` writes SelectList's private arrays behind a loud guard).
  Don't "clean these up" without reading that file; some are unavoidable until pi adds APIs.
- **Releases are automated.** Bump `package.json`/`package-lock.json`, add a `## X.Y.Z` section to
  `CHANGELOG.md`, then push the `vX.Y.Z` tag — `.github/workflows/release.yml` runs check+test,
  publishes to npm (OIDC trusted publishing, no token), and creates a GitHub Release from that
  CHANGELOG section. **The heading must be exactly `## X.Y.Z` to match the `vX.Y.Z` tag**, or the
  extractor falls back to auto-generated notes.
- Match the surrounding style (tabs, no semicolon-free experiments); keep the package
  dependency-free (`dependencies: {}` — pi packages are peers).
