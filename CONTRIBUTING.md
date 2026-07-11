# Contributing to pi-dialer

Thanks for helping improve pi-dialer.

## Development setup

```bash
cd pi-dialer
npm install
npm run check
npm test
```

To try the extension locally without installing it globally:

```bash
pi -e .
```

Or install the local package into pi:

```bash
pi install .
```

## Pull requests

Before opening a PR:

1. Run `npm run check`.
2. Run `npm test`.
3. Update `README.md` and `CHANGELOG.md` for user-visible behavior changes.
4. Keep the public workflow simple: selecting the Pi Dialer model, `/dialer`, `/dialer-setup`, and `/dialer-status` should remain the primary UX.

## Design principles

- Routing is user-owned configuration: the LLM has no tool to change routes, models, or thinking levels.
- The virtual dialer model must never stream. Any path that could leave it active has to switch away or block the prompt.
- Degrade gracefully: an unknown or unauthed route model warns and keeps the current model; the prompt still runs.
- The classifier stays a pure function behind the `Classification` result shape, so an eval/LLM-based classifier can replace it without touching the routing.
- Prefer native pi TUI components over writing large text blobs into the editor.
- Keep dependencies minimal and list pi runtime packages as peer dependencies.

## Issues

Please include:

- pi version
- pi-dialer version or commit
- install method (`npm`, `git`, or local path)
- command invocation used
- expected behavior
- actual behavior
- relevant config from `~/.pi/agent/dialer.json` or `.pi/dialer.json` with secrets removed
