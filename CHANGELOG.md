# Changelog

## 0.2.0

- **Named setups**: `/dialer save <name>` snapshots the current routes into a reusable setup;
  `/dialer use <name>` switches between them (`use none` returns to the top-level routes; bare
  `use` lists them). Setups live under `setups`/`activeSetup` in the global `dialer.json`, and
  `/dialer-setup` edits the active setup when one is active. The active setup shows in
  `/dialer-status` and the keyed footer status (`Dialer [quality]: on`).
- **Footer model display**: while the dialer is on, the virtual model stays selected between
  prompts, so pi's bottom-right model indicator reads `pi-dialer` (the model id changed from
  `auto` to `pi-dialer`, and `reasoning: false` suppresses the thinking-level suffix). Each run
  still switches to the real routed model — visible while streaming — and parks back afterwards.
- `/dialer on` parks the selection on the virtual model; `/dialer off` returns to a real model
  (default route → last real model → first authed).

## 0.1.0

Initial release of pi-dialer (repurposed from the pi-fusion codebase; see the git history for its
changelog).

- Virtual **Pi Dialer** model in pi's model picker: selecting it turns per-prompt routing on;
  selecting a real model manually turns it off. The virtual model never streams — the extension
  switches back to a real model immediately, with an error-stream fallback if it is ever invoked.
- Keyword classifier with built-in task types `plan`, `implement`, `deep-dive`, and `quick-edit`
  plus a `default` fallback. Longer phrases outweigh single words; ties keep the earliest
  configured route; custom task types are supported via `dialer.json`.
- Per-route `model` and `thinking` applied via pi's `setModel`/`setThinkingLevel` before each
  agent run, with graceful degradation (unknown/unauthed models warn and keep the current model).
- `/dialer` (on/off/status toggle), `/dialer-setup` (interactive per-task model + thinking picker
  that writes the global `~/.pi/agent/dialer.json`), `/dialer-status`, and `/dialer-init`
  (project `.pi/dialer.json` template seeded from authed models).
- Dialer on/off state persists in the session and is restored on `/resume`; the footer shows what
  each prompt was dialed to via pi's keyed status API.
- Each routed response ends with a stamp of what ran and why:
  `Dialer: quick-edit → openai/gpt-4.1-mini · thinking off · matched: "rename"` (appended to the
  final assistant message via the `message_end` event).
