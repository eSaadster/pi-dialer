# Security Policy

pi packages run with the same local permissions as the user running pi. Review extensions before installing them.

## Reporting a vulnerability

Please report security issues privately by opening a GitHub security advisory if available, or by contacting the maintainers.

Do not include secrets, API keys, session files, or private repository content in public issues.

## Scope

Security-sensitive areas include:

- Unsafe file writes or shell execution
- Leaking API keys or provider headers
- Exposing private conversation or repository context unexpectedly
- Loading project-local config without trust checks
- Tool-result or prompt-injection paths that bypass user intent

## Current behavior

pi-dialer makes no LLM calls of its own and registers no LLM-callable tools; it only switches pi's active model and thinking level based on user-owned configuration. Project-local `.pi/dialer.json` is loaded only for trusted projects. The virtual `dialer/auto` model is registered with a dummy key and an error-returning stream handler so it can never send a request anywhere.
