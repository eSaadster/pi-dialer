# pi-dialer

Automatic per-prompt model and thinking-level routing for [pi](https://pi.dev/).

Pick **Pi Dialer** as your model, and every prompt you type is classified into a task type —
planning, implementing, deep-diving into a codebase, or a quick edit — and routed to the model and
thinking level you configured for that kind of work. Big-brain model with high reasoning for
architecture questions, cheap fast model for renaming a file, without touching the model picker
between prompts.

## Why

Choosing a model and a thinking level for *every prompt* is cognitive load that adds up fast.
pi-dialer removes the per-prompt decision: describe your preferences once, and let the dialer pick
based on what you're actually asking for. It works across all your authed models and all of pi's
provider-neutral thinking levels, `off` through `xhigh` (there's no `max` level wired up — I don't
use one — but it's an easy addition if your setup has it).

Configs scale with how you work: save **named setups** and switch between them (`/dialer save`,
`/dialer use`), keep one **global config** that follows you everywhere, and drop a **per-project
config** (`.pi/dialer.json`) into long-term projects that deserve their own routing.

> **PS:** I haven't explored/observed provider **caching behavior** under per-prompt model
> switching yet — prompt caches are per-model, so frequent switching may affect cache hits; worth
> watching. And a future idea: use **evals to generate configs** — an Artificial Analysis config,
> a Vals config, a VulcanBench config — pick the benchmarks you trust, let them assign the model
> and thinking level per task type, and make *that* your dialer.

## How it works

1. `pi.registerProvider` adds a virtual **Pi Dialer** model to pi's model picker. Selecting it
   turns the dialer on; while the dialer is on, the virtual model stays selected between prompts,
   so pi's footer reads **`pi-dialer`** instead of a specific model. Each run switches to the real
   routed model and parks back afterwards — the virtual model itself never receives a request.
   Selecting any real model by hand turns the dialer off.
2. While the dialer is on, each prompt is matched against keyword phrases per task type. The
   best-scoring task wins; longer phrases score higher ("quick fix" beats "fix"), and a prompt
   that matches nothing falls back to the `default` route.
3. The model and thinking level configured for the winning task are applied via pi's
   `setModel`/`setThinkingLevel` before the agent starts, and the footer shows what was dialed:
   `Dialer: plan → anthropic/claude-opus-4-5 (high)`.
4. Each routed response ends with a stamp of what actually ran and why:

   ```
   ---
   _Dialer: quick-edit → openai/gpt-4.1-mini · thinking off · matched: "rename"_
   ```

Classification is keyword-based today. An eval-based (LLM-scored) dialer is a planned follow-up —
the classifier is a pure function behind a small result shape, so it can be swapped without
touching the routing.

## Built-in task types

| Task | Example triggers | Typical route |
|------|------------------|---------------|
| `plan` | plan, think through, design, architecture, trade-offs, should we | strongest model, high thinking |
| `implement` | implement, build, add, create, write, refactor, fix | solid coding model, medium thinking |
| `deep-dive` | explain, understand, how does, analyze, deep dive, extract, audit | long-context model, high thinking |
| `quick-edit` | rename, move, delete, typo, tweak, bump, quick fix, format | fast cheap model, low/off thinking |
| `default` | anything that matches nothing above | your everyday model |

You can add your own task types in `dialer.json` (any route name with its own keywords), and
replace the keyword list of any built-in.

## Install

```bash
pi install /path/to/pi-dialer   # from a local checkout
pi install npm:pi-dialer        # from npm, once published
```

After installing or updating in a running session, run `/reload`.

There's no build step; pi loads the TypeScript directly via [jiti](https://github.com/unjs/jiti).
Requires Node ≥ 22.19.0 and Pi ≥ 0.74.0.

## Quick start

```
# 1. configure which model + thinking level each task type gets
/dialer-setup

# 2. turn the dialer on: pick "Pi Dialer" in the model picker, or
/dialer on

# 3. just type; the footer shows what each prompt was dialed to
Think through how we should shard the events table.
Rename utils.ts to helpers.ts.
```

Check what's active any time with `/dialer-status`. Selecting a real model manually (or
`/dialer off`) stops the routing.

## Commands

| Command | What it does |
|---------|--------------|
| `/dialer` | Toggle routing on/off for the session. |
| `/dialer on` \| `off` \| `status` | Set the state explicitly, or show status (aliases: `enable`, `disable`). |
| `/dialer use <name>` | Activate a named setup (`/dialer use none` returns to the top-level routes; bare `/dialer use` lists setups). |
| `/dialer save <name>` | Save the currently effective routes as a named setup and activate it. |
| `/dialer-setup` | Interactive picker: per task type, choose a model and thinking level. Writes the global `dialer.json` — into the active named setup when one is active (interactive mode only). |
| `/dialer-status` | Show on/off state, the config file in use, the active/available setups, and every resolved route. |
| `/dialer-init` | Write a project-local `.pi/dialer.json` template seeded from your authed models (confirms before overwriting; trusted projects only). |

Dialer on/off state is saved in the session and restored on `/resume`.

### Named setups

Keep several route sets and switch between them without editing JSON:

```
/dialer save quality     # snapshot the current routes as "quality" and activate it
/dialer-setup            # edits now apply to the active setup
/dialer save cheap       # snapshot the (edited) routes as a second setup
/dialer use quality      # switch back
/dialer use none         # deactivate; use the top-level routes again
```

In `dialer.json`, setups live under `setups` with the same `routes` shape, and `activeSetup` names
the one in effect:

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

`/dialer use` and `/dialer save` always edit the global config; an unknown `activeSetup` warns and
falls back to the top-level routes.

## Configuration

Routes live in either of:

- `~/.pi/agent/dialer.json` (global — this is what `/dialer-setup` writes)
- `<cwd>/.pi/dialer.json` (project-local, wins over global; loaded only for trusted projects)

The first file found is used whole; the two files are not merged. Generate a project template with
`/dialer-init`, or write one by hand:

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
| `keywords` | built-in list for that task | Phrases that select this route (case-insensitive, word-boundary, whitespace-tolerant). Setting it **replaces** the built-in list. Custom route names require it to ever match. |
| `model` | keep current model | Model to switch to, as `provider/id` (a bare `id` matches across providers). Unset = the route only adjusts thinking. |
| `thinking` | leave untouched | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. pi clamps levels the model doesn't support. |

Resolution details:

- **Scoring.** Each matched phrase scores its word count; the route with the highest total wins.
  Ties keep the earliest route: config-defined routes first (in file order), then the remaining
  built-ins (`plan`, `implement`, `deep-dive`, `quick-edit`).
- **`default` is the fallback**, never keyword-matched, and always resolves last.
- A route model that isn't authed (or unknown) is skipped with a warning and the current model is
  kept — the prompt still runs.
- Only authed models are offered in `/dialer-setup`, and the model registry is consulted per
  prompt, so revoking a provider degrades gracefully.

## FAQ

**Does the dialer change my model permanently?**

It calls the same `setModel` the model picker uses. While a prompt runs, the footer shows the real
model that's streaming; between prompts the selection parks back on **`pi-dialer`** so the footer
tells you the dialer is in charge rather than any one model. Picking a model by hand turns the
dialer off and leaves your choice alone.

**What happens if my prompt matches two task types?**

The higher total score wins; longer phrases are worth more. On an exact tie the earliest route in
the resolved order wins (see Resolution details above).

**Can the LLM override my routes?**

No. There is no LLM-callable tool in this extension. Routing runs on your input, before the agent
sees the prompt, from configuration only you can edit.

**Why did nothing switch?**

Run `/dialer-status`: the dialer may be off, the route's model may not be authed, or the prompt
fell through to a `default` route with no model configured (which means "keep the current model").

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
