# pi-dialer

Automatic per-prompt model and thinking-level routing for [pi](https://pi.dev/).

Pick **Pi Dialer** as your model. The dialer reads each prompt, matches it to a task type
(planning, implementing, digging into a codebase, or a quick edit), and switches to the model and
thinking level you configured for that kind of work. A strong model with high reasoning answers
your architecture questions, and a cheap fast one renames your file. You don't touch the model
picker between prompts.

## Why

Picking a model and a thinking level for each prompt is cognitive load, and it adds up. Describe
your preferences once and the dialer picks for you, based on what you ask. It works with any
authenticated text model available to pi and supports thinking levels from `off` through `xhigh`.

Save **named setups** and switch between them with `/dialer save` and `/dialer use`. A single
**global config** follows you everywhere, and a long-term project can carry its own
`.pi/dialer.json` when it deserves different routing.


## How it works

1. `pi.registerProvider` adds a virtual **Pi Dialer** model to pi's model picker. Select it to
   turn the dialer on. While the dialer is on, the virtual model stays selected between prompts,
   so pi's footer reads **`pi-dialer`**. Each run switches to the routed model and parks back
   afterwards, and the virtual model itself receives no requests. Select a real model by hand to
   turn the dialer off.
2. The dialer scores each prompt against keyword phrases per task type. The best-scoring task
   wins. Longer phrases score higher ("quick fix" beats "fix"), and a prompt that matches nothing
   falls back to the `default` route.
3. The dialer applies the winning task's model and thinking level through pi's
   `setModel`/`setThinkingLevel` before the agent starts, and the footer shows the pick, e.g.
   `Dialer: plan → anthropic/claude-opus-4-5 (high)`. Skill and prompt-template commands
   (`/wraiter …`) are routed too, by their expanded prompt.
4. Manual `/compact` and automatic threshold compaction run against a real model while the
   dialer is parked on its virtual model. The dialer prefers the `default` route's model, then
   the last real model used, then any authenticated text model. If none is available, it cancels
   compaction with a notification instead of sending the request to the virtual router.
5. Each routed response ends with a stamp showing what ran and why.

   ```
   ---
   _Dialer: quick-edit → openai/gpt-4.1-mini · thinking off · matched: "rename"_
   ```

Classification is keyword-based today. An eval-based dialer is a planned follow-up. The classifier
is a pure function behind a small result shape, so you can swap in a smarter one without touching
the routing.

## Built-in task types

| Task | Example triggers | Typical route |
|------|------------------|---------------|
| `plan` | plan, think through, design, architecture, trade-offs, should we | strongest model, high thinking |
| `implement` | implement, build, add, create, write, refactor, fix | solid coding model, medium thinking |
| `deep-dive` | explain, understand, how does, analyze, deep dive, extract, audit | long-context model, high thinking |
| `quick-edit` | rename, move, delete, typo, tweak, bump, quick fix, format | fast cheap model, low/off thinking |
| `default` | anything that matches nothing above | your everyday model |

Add your own task types in `dialer.json` (any route name with its own keywords), and replace the
keyword list of any built-in.

## Install

```bash
pi install /path/to/pi-dialer   # from a local checkout
pi install npm:pi-dialer        # from npm
```

After installing or updating in a running session, run `/reload`.

There's no build step. pi loads the TypeScript via [jiti](https://github.com/unjs/jiti). Requires
Node ≥ 22.19.0 and Pi ≥ 0.74.0.

## Quick start

```
# 1. configure which model + thinking level each task type gets
/dialer-setup

# 2. turn the dialer on: pick "Pi Dialer" in the model picker, or
/dialer on

# 3. type; the footer shows what each prompt was dialed to
Think through how we should shard the events table.
Rename utils.ts to helpers.ts.
```

Check what's active with `/dialer-status`. Pick a real model by hand (or run `/dialer off`) to
stop the routing.

## Commands

| Command | What it does |
|---------|--------------|
| `/dialer` | Toggle routing on/off for the session. |
| `/dialer on` \| `off` \| `status` | Set the state, or show status (aliases `enable` and `disable`). |
| `/dialer use <name>` | Activate a named setup (`/dialer use none` returns to the top-level routes; bare `/dialer use` lists setups). |
| `/dialer save <name>` | Save the current routes as a named setup and activate it. |
| `/dialer-setup` | Interactive picker. Per task type, choose a model and thinking level. Writes the global `dialer.json`, into the active named setup when one is active (interactive mode only). |
| `/dialer-status` | Show on/off state, the config file in use, the active and available setups, and every resolved route. |
| `/dialer-init` | Write a project-local `.pi/dialer.json` template seeded from your authed models (confirms before overwriting; trusted projects only). |

The dialer saves its on/off state in the session and restores it on `/resume`.

### Named setups

Keep several route sets and switch between them without editing JSON.

```
/dialer save quality     # snapshot the current routes as "quality" and activate it
/dialer-setup            # edits now apply to the active setup
/dialer save cheap       # snapshot the (edited) routes as a second setup
/dialer use quality      # switch back
/dialer use none         # deactivate; use the top-level routes again
```

In `dialer.json`, setups live under `setups` with the same `routes` shape, and `activeSetup` names
the one in effect.

```json
{
  "activeSetup": "quality",
  "setups": {
    "quality": { "routes": { "plan": { "model": "anthropic/claude-opus-4-5", "thinking": "xhigh" } } },
    "cheap":   { "routes": { "plan": { "model": "openai/gpt-4.1-mini", "thinking": "low" } } }
  },
  "routes": { }
}
```

`/dialer use` and `/dialer save` edit the global config. When `activeSetup` names a missing setup,
the dialer warns you and falls back to the top-level routes.

## Configuration

Routes live in two places.

- `~/.pi/agent/dialer.json` (global, what `/dialer-setup` writes)
- `<cwd>/.pi/dialer.json` (project-local, wins over global; loaded for trusted projects only)

The dialer uses the first file it finds as a complete config; it does not merge the two. A
trusted project's config overrides the global config, so fix or remove the project file if you
want the global settings to apply there. Generate a project template with `/dialer-init`, or
write one by hand.

```json
{
  "routes": {
    "plan": {
      "model": "anthropic/claude-opus-4-5",
      "thinking": "high"
    },
    "implement": {
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "medium"
    },
    "deep-dive": {
      "model": "google/gemini-2.5-pro",
      "thinking": "high"
    },
    "quick-edit": {
      "keywords": ["rename", "move", "delete", "typo", "bump", "quick fix"],
      "model": "openai/gpt-4.1-mini",
      "thinking": "low"
    },
    "research": {
      "keywords": ["benchmark", "compare libraries", "state of the art"],
      "model": "openai/gpt-4.1",
      "thinking": "xhigh"
    },
    "default": {
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "medium"
    }
  }
}
```

Per route:

| Field | Default | Description |
|-------|---------|-------------|
| `keywords` | built-in list for that task | Phrases that select this route (case-insensitive, word-boundary, whitespace-tolerant). Setting it **replaces** the built-in list. A custom route needs keywords to match at all. |
| `model` | keep current model | Model to switch to, as `provider/id` (a bare `id` matches across providers). Unset = the route only adjusts thinking. |
| `thinking` | leave untouched | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. pi clamps levels the model doesn't support. |

Resolution details:

- **Scoring.** Each matched phrase scores its word count, and the route with the highest total
  wins. Ties keep the earliest route in the resolved order, which is config-defined routes first
  (file order), then the remaining built-ins (`plan`, `implement`, `deep-dive`, `quick-edit`).
- **`default` is the fallback.** It has no keywords and resolves last.
- The dialer skips an unknown or unauthed route model, warns you, and keeps the current model.
  The prompt still runs.
- `/dialer-setup` offers authed models only, and the dialer re-checks the registry on each
  prompt, so a revoked provider produces a warning and the prompt runs on your current model.

## FAQ

**Does the dialer change my model permanently?**

It calls the same `setModel` the model picker uses. While a prompt runs, the footer shows the
model that's streaming. Between prompts the selection parks back on **`pi-dialer`**, a reminder
that the dialer is in charge. Pick a model by hand and the dialer turns off and leaves your choice
alone.

**What happens if my prompt matches two task types?**

The higher total score wins, and longer phrases are worth more. On an exact tie the earliest route
in the resolved order wins (see Resolution details above).

**Can the LLM override my routes?**

No. This extension registers no LLM-callable tool. Routing runs on your input, before the agent
sees the prompt, from configuration only you can edit.

**How does compaction work while the dialer is enabled?**

Manual `/compact` and automatic threshold compaction use a real model instead of the parked
virtual model. The dialer prefers the `default` route model, then the last real model used, then
any authenticated text model. If no model is available, it cancels compaction and explains why.

**Why did nothing switch?**

Run `/dialer-status` and look. The dialer may be off, the route's model may not be available or
authenticated, or the prompt may have fallen through to a `default` route with no model
configured, which means "keep the current model".

## Development

```bash
npm install    # installs peer deps for type-checking and tests
npm run check  # tsc --noEmit
npm test       # runs every suite in src/__tests__/
npm pack --dry-run
```

There's no build step. Try the extension live with `pi -e .`, then `/reload` after edits.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and PR guidelines,
[SECURITY.md](SECURITY.md) for reporting vulnerabilities, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
