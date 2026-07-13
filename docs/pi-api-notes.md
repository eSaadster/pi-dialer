# pi API gaps & workarounds

Notes verified against the installed `@earendil-works/*` `.d.ts`. These are gaps in **pi's**
public API / docs that force workarounds in this extension — captured here so they aren't
re-discovered, and as candidates to file upstream. The workarounds are intentional; each carries a
matching `// pi gap:` comment at its call site.

## Missing public APIs

- **`SelectList` has no public `setItems()`.** `items`/`filteredItems` are `private`
  (`pi-tui/dist/components/select-list.d.ts`) and the only public mutator, `setFilter`, just
  prefix-matches on `value`. To re-render the model picker after a multi-field search,
  `src/ui.ts` (`setSelectListItems`) writes those private arrays — guarded by a runtime shape
  assertion so a future pi-tui rename fails loudly instead of silently. A public
  `SelectList.setItems(items: SelectItem[])` would remove the workaround.

## Sharp edges

- **`registerProvider`'s `streamSimple` is registered per `api`, not per provider.**
  `ModelRegistry.applyProviderConfig` calls pi-ai's `registerApiProvider`, whose registry is a
  `Map` keyed by `api` (`pi-ai/dist/api-registry.js`). Registering the virtual dialer model with
  `api: "openai-completions"` therefore replaced the built-in streaming for **every**
  openai-completions model — each of them streamed the dialer's "router, not a model" error stub.
  The virtual model now uses a private `api: "pi-dialer"` (`DIALER_API` in `src/index.ts`) so the
  stub only claims its own API id. Upstream candidate: key custom `streamSimple` registrations by
  provider, or at least warn on overriding a built-in api.

## Used but documented only in `.d.ts` (not in `docs/*.md`)

These work fine but are undocumented; relying on them is a small risk:

- `getSelectListTheme()` (only `getSettingsListTheme` is in `docs/tui.md`).
- `ModelRegistry.getAvailable()` and `hasConfiguredAuth()`.
- `pi.registerProvider` with a custom `streamSimple` handler (used to make the virtual dialer
  model fail loudly if it is ever streamed), and `createAssistantMessageEventStream` from
  `@earendil-works/pi-ai`.
- `pi.setModel` / `pi.setThinkingLevel` and the `model_select` event's `source` field
  (`"set" | "cycle" | "restore"`), which the dialer relies on to distinguish manual model picks
  (turn the dialer off) from session restore (keep it on).
