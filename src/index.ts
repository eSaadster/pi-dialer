/**
 * pi-dialer: automatic per-prompt model + thinking-level routing.
 *
 * Registers a virtual "Pi Dialer" model in pi's model picker. Selecting it
 * turns the dialer on; while on, the virtual model stays selected between
 * prompts so pi's footer reads "pi-dialer" instead of a specific model. Each
 * prompt is classified by keywords into a task type (plan / implement /
 * deep-dive / quick-edit / custom), the model + thinking level configured for
 * that task are applied for the run, and afterwards the selection parks back
 * on the virtual model. The virtual model itself never streams: routing
 * always switches to a real model first (or blocks the prompt with an error).
 * Selecting a real model by hand turns the dialer off.
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { compact } from "@earendil-works/pi-coding-agent";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { classifyPrompt, DEFAULT_TASK } from "./classify.ts";
import {
	activateSetup,
	deactivateSetup,
	effectiveSetup,
	generateConfigExample,
	globalConfigPath,
	loadConfig,
	loadGlobalConfig,
	mergeRouteSelections,
	projectConfigPath,
	resolveRoutes,
	type RouteSelections,
	saveConfig,
	saveSetupSnapshot,
} from "./config.ts";
import { modelDisplay, resolveModelIdentifier, sameModel } from "./models.ts";
import { rowModelLabel, selectDialerSetup, type SetupRow, thinkingLabel } from "./ui.ts";
import type { Api, Model, ResolvedRoute, ThinkingLevel } from "./types.ts";

export const DIALER_PROVIDER = "dialer";
// The id is what pi's footer shows bottom-right while the dialer is parked.
export const DIALER_MODEL_ID = "pi-dialer";
// pi registers a provider's streamSimple in pi-ai's api registry keyed by
// `api` — a shared value like "openai-completions" would hijack streaming for
// every real model on that API. A private api id keeps the error stub scoped
// to the virtual model.
export const DIALER_API: Api = "pi-dialer";

const STATE_ENTRY = "dialer-state";

export type DialerCommand =
	| { kind: "on" }
	| { kind: "off" }
	| { kind: "status" }
	| { kind: "toggle" }
	| { kind: "use"; name?: string }
	| { kind: "save"; name?: string }
	| { kind: "error"; message: string };

/** Parse `/dialer` arguments. Empty toggles; on/off/status/use/save map directly. */
export function parseDialerCommand(args: string): DialerCommand {
	const trimmed = args.trim();
	const arg = trimmed.toLowerCase();
	if (!arg) return { kind: "toggle" };
	if (arg === "on" || arg === "enable" || arg === "enabled") return { kind: "on" };
	if (arg === "off" || arg === "disable" || arg === "disabled") return { kind: "off" };
	if (arg === "status") return { kind: "status" };
	if (arg === "use" || arg.startsWith("use ")) {
		const name = trimmed.slice(3).trim();
		return { kind: "use", name: name || undefined };
	}
	if (arg === "save" || arg.startsWith("save ")) {
		const name = trimmed.slice(4).trim();
		return { kind: "save", name: name || undefined };
	}
	return {
		kind: "error",
		message: `Unknown /dialer argument "${trimmed}". Use on, off, status, use <setup>, or save <setup>.`,
	};
}

/** Footer status text for the dialer, or undefined to clear it. */
export function dialerStatusText(on: boolean, routeNote?: string, setup?: string): string | undefined {
	if (!on) return undefined;
	const label = setup ? `Dialer [${setup}]` : "Dialer";
	return `${label}: ${routeNote ?? "on"}`;
}

/** One-line description of what a routed prompt was dialed to. */
export function routeNote(task: string, model: string | undefined, thinking: ThinkingLevel | undefined): string {
	const parts = [`${task} → ${model ?? "current model"}`];
	if (thinking) parts.push(`(${thinking})`);
	return parts.join(" ");
}

/** What the dialer picked for the in-flight prompt, stamped onto the response. */
export interface PendingRouteNote {
	task: string;
	model?: string;
	thinking?: ThinkingLevel;
	matched: string[];
}

/** Markdown footer appended to a routed response (mirrors pi-read-coverage). */
export function formatRouteFooter(note: PendingRouteNote): string {
	const shown = note.matched.slice(0, 4).map((k) => `"${k}"`).join(", ");
	const matched = note.matched.length === 0
		? "no keyword match"
		: `matched: ${shown}${note.matched.length > 4 ? ", …" : ""}`;
	return `\n\n---\n_Dialer: ${note.task} → ${note.model ?? "current model"} · thinking ${note.thinking ?? "keep"} · ${matched}_`;
}

/** Auth lookup result, structurally matching `ModelRegistry.getApiKeyAndHeaders`. */
type RequestAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

/** Seams of the `session_before_compact` handler, injectable for tests. */
export interface DialerCompactionDeps {
	/** True when the virtual dialer model is the current selection. */
	parked: boolean;
	/** Real model to summarize with (the fallbackRealModel chain). */
	model: Model<Api> | undefined;
	getAuth: (model: Model<Api>) => Promise<RequestAuth>;
	compactFn: typeof compact;
	notify: (message: string, level: "error") => void;
}

/**
 * Compaction summarizes with the *selected* model, and pi captures that
 * model's auth before `session_before_compact` fires — so while parked on the
 * virtual model, pi's own compaction hits the "router, not a model" error and
 * an in-handler model switch would run with the virtual model's fake auth.
 * Instead, run compaction here against a real model and hand pi the finished
 * result. Failures cancel (with a notify saying why) rather than fall
 * through, because falling through re-runs against the unstreamable virtual
 * model.
 */
export async function dialerCompaction(
	event: Pick<SessionBeforeCompactEvent, "preparation" | "customInstructions" | "signal">,
	deps: DialerCompactionDeps,
): Promise<{ compaction: CompactionResult } | { cancel: true } | undefined> {
	if (!deps.parked) return undefined;
	if (!deps.model) {
		deps.notify(
			"Dialer: no authed model to compact with. Configure a `default` route model in /dialer-setup or pick a model manually.",
			"error",
		);
		return { cancel: true };
	}
	const auth = await deps.getAuth(deps.model);
	if (!auth.ok) {
		deps.notify(`Dialer: cannot compact with ${modelDisplay(deps.model)}: ${auth.error}`, "error");
		return { cancel: true };
	}
	try {
		const compaction = await deps.compactFn(
			event.preparation,
			deps.model,
			auth.apiKey,
			auth.headers,
			event.customInstructions,
			event.signal,
		);
		return { compaction };
	} catch (err) {
		// An abort already surfaces as "Compaction cancelled" in pi; only
		// notify for real failures.
		if (!event.signal.aborted) {
			const reason = err instanceof Error ? err.message : String(err);
			deps.notify(`Dialer: compaction with ${modelDisplay(deps.model)} failed: ${reason}`, "error");
		}
		return { cancel: true };
	}
}

export default function (pi: ExtensionAPI) {
	let dialerOn = false;
	/** Guards model_select against reacting to the extension's own setModel calls. */
	let selfSwitch = false;
	/** Routing decision for the prompt currently streaming, shown under its response. */
	let pendingNote: PendingRouteNote | undefined;
	/** Last real model seen, used when a route keeps "current model" or the dialer turns off. */
	let lastRealModel: Model<Api> | undefined;

	// The virtual "model" that makes the dialer selectable from pi's model
	// picker and shows as "pi-dialer" in the footer while the dialer is parked.
	// It must never actually stream: routing switches to a real model before
	// each run. reasoning: false keeps pi's footer from appending a thinking
	// level next to the name. streamSimple is a belt-and-suspenders error in
	// case it is ever invoked anyway. Kept as a named config so
	// syncDialerWindow can re-register it with updated contextWindow/maxTokens.
	const dialerProvider: Parameters<ExtensionAPI["registerProvider"]>[1] = {
		name: "Pi Dialer",
		baseUrl: "https://pi-dialer.invalid",
		apiKey: "pi-dialer",
		api: DIALER_API,
		streamSimple: (model) => {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage:
					"Pi Dialer is a router, not a model. It should have switched to a real model automatically — pick a real model, then run /dialer on (see /dialer-status).",
				timestamp: Date.now(),
			};
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
			return stream;
		},
		models: [
			{
				id: DIALER_MODEL_ID,
				name: "Pi Dialer",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// Placeholders until the first park: pi computes the footer's
				// context % and the auto-compaction threshold from the *selected*
				// model, so syncDialerWindow overwrites these with the real
				// model's numbers whenever the dialer parks.
				contextWindow: 200_000,
				maxTokens: 8_192,
			},
		],
	};
	pi.registerProvider(DIALER_PROVIDER, dialerProvider);

	function persistState(on: boolean) {
		pi.appendEntry(STATE_ENTRY, { on, timestamp: Date.now() });
	}

	function restoreState(ctx: ExtensionContext): boolean | undefined {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && "data" in entry && entry.data) {
				return !!(entry.data as { on?: boolean }).on;
			}
		}
		return undefined;
	}

	function updateStatus(ctx: ExtensionContext, note?: string) {
		const { setupName } = effectiveSetup(loadConfig(ctx.cwd, ctx.isProjectTrusted()).config);
		ctx.ui.setStatus("dialer", dialerStatusText(dialerOn, note, setupName));
	}

	function routesFor(ctx: ExtensionContext): ResolvedRoute[] {
		return resolveRoutes(loadConfig(ctx.cwd, ctx.isProjectTrusted()).config);
	}

	async function switchModel(model: Model<Api>): Promise<boolean> {
		selfSwitch = true;
		try {
			const ok = await pi.setModel(model);
			if (ok && model.provider !== DIALER_PROVIDER) lastRealModel = model;
			return ok;
		} finally {
			selfSwitch = false;
		}
	}

	/**
	 * A real model to run against when a route keeps "current model" but the
	 * virtual dialer model is what's selected: the default route's model, then
	 * the last real model seen, then any authed text model.
	 */
	function fallbackRealModel(ctx: ExtensionContext): Model<Api> | undefined {
		const defaultRoute = routesFor(ctx).find((r) => r.task === DEFAULT_TASK);
		if (defaultRoute?.model) {
			const model = resolveModelIdentifier(ctx.modelRegistry, defaultRoute.model);
			if (model && model.provider !== DIALER_PROVIDER && ctx.modelRegistry.hasConfiguredAuth(model)) {
				return model;
			}
		}
		if (lastRealModel && ctx.modelRegistry.hasConfiguredAuth(lastRealModel)) return lastRealModel;
		return ctx.modelRegistry
			.getAvailable()
			.find((m) => m.provider !== DIALER_PROVIDER && m.input.includes("text"));
	}

	/**
	 * While parked, pi reads the *selected* model's contextWindow/maxTokens for
	 * the footer's context % and the auto-compaction threshold — the virtual
	 * model's placeholder numbers would cap a bigger-window route (e.g. 372k
	 * Codex models against the 200k placeholder). Mirror the model the next
	 * prompt and compaction would actually use (fallbackRealModel: default
	 * route → last real → any authed) by re-registering the provider, which
	 * replaces the registry's virtual model entry.
	 */
	function syncDialerWindow(ctx: ExtensionContext) {
		const source = fallbackRealModel(ctx);
		const spec = dialerProvider.models?.[0];
		if (!source || !spec) return;
		if (spec.contextWindow === source.contextWindow && spec.maxTokens === source.maxTokens) return;
		spec.contextWindow = source.contextWindow;
		spec.maxTokens = source.maxTokens;
		pi.registerProvider(DIALER_PROVIDER, dialerProvider);
	}

	/** Park the selection on the virtual model so pi's footer reads "pi-dialer". */
	async function parkOnDialer(ctx: ExtensionContext) {
		if (ctx.model && ctx.model.provider !== DIALER_PROVIDER) lastRealModel = ctx.model;
		syncDialerWindow(ctx);
		const virtual = ctx.modelRegistry.find(DIALER_PROVIDER, DIALER_MODEL_ID);
		if (!virtual) return;
		// Already parked and current: nothing to do. Re-select when the window
		// changed even while parked (session restore replays the model object
		// saved with the old numbers) — pi reads the selected object, not the
		// registry.
		if (
			ctx.model?.provider === DIALER_PROVIDER &&
			ctx.model.contextWindow === virtual.contextWindow &&
			ctx.model.maxTokens === virtual.maxTokens
		) {
			return;
		}
		await switchModel(virtual);
	}

	/** Leave the virtual model for a real one (dialer turning off / no route model). */
	async function unparkFromDialer(ctx: ExtensionContext) {
		if (ctx.model?.provider !== DIALER_PROVIDER) return;
		const target = fallbackRealModel(ctx);
		if (!target) {
			ctx.ui.notify("Dialer: no authed model to switch to. Authenticate a provider first.", "error");
			return;
		}
		if (!(await switchModel(target))) {
			ctx.ui.notify(`Dialer: could not switch to ${modelDisplay(target)} (no API key).`, "warning");
		}
	}

	pi.on("model_select", async (event, ctx) => {
		if (selfSwitch) return;
		if (event.model.provider === DIALER_PROVIDER) {
			if (event.previousModel && event.previousModel.provider !== DIALER_PROVIDER) {
				lastRealModel = event.previousModel;
			}
			if (!dialerOn) {
				dialerOn = true;
				persistState(true);
				ctx.ui.notify("Dialer on: prompts now pick the model and thinking level per task. /dialer off to stop.", "info");
			}
			updateStatus(ctx);
			return;
		}
		lastRealModel = event.model;
		// A manual switch to a real model turns the dialer off. Session restore
		// ("restore") must not: it replays the last active model on /resume.
		if (dialerOn && event.source !== "restore") {
			dialerOn = false;
			persistState(false);
			updateStatus(ctx);
			ctx.ui.notify("Dialer off (model selected manually).", "info");
		}
	});

	/**
	 * Classify `text`, apply the winning route's model + thinking level, and
	 * stash the response stamp. Returns false when no real model could be made
	 * active — the parked virtual model would be what streams.
	 */
	async function applyRoute(text: string, ctx: ExtensionContext): Promise<boolean> {
		const routes = routesFor(ctx);
		const classification = classifyPrompt(text, routes);
		const route = routes.find((r) => r.task === classification.task);

		let target: Model<Api> | undefined;
		if (route?.model) {
			const model = resolveModelIdentifier(ctx.modelRegistry, route.model);
			if (!model) {
				ctx.ui.notify(`Dialer: unknown model "${route.model}" for task "${route.task}"; keeping current model.`, "warning");
			} else if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				ctx.ui.notify(`Dialer: model ${modelDisplay(model)} for task "${route.task}" is not authed; keeping current model.`, "warning");
			} else {
				target = model;
			}
		}
		// A route without a usable model means "keep the current model" — but the
		// parked virtual model can't stream, so fall back to a real one.
		if (!target && ctx.model?.provider === DIALER_PROVIDER) {
			target = fallbackRealModel(ctx);
		}

		let routedModel: Model<Api> | undefined;
		if (target) {
			if (sameModel(ctx.model, target)) {
				routedModel = target;
			} else if (await switchModel(target)) {
				routedModel = target;
			} else {
				ctx.ui.notify(`Dialer: could not switch to ${modelDisplay(target)} (no API key); keeping current model.`, "warning");
			}
		}
		if (route?.thinking) pi.setThinkingLevel(route.thinking);

		// Never let a prompt stream against the virtual dialer model (possible
		// when no real model could be resolved at all).
		const effective = routedModel ?? ctx.model;
		if (!routedModel && ctx.model?.provider === DIALER_PROVIDER) {
			ctx.ui.notify("Dialer: no real model active. Configure a `default` route model in /dialer-setup or pick a model manually.", "error");
			return false;
		}

		updateStatus(ctx, routeNote(
			classification.task,
			effective ? modelDisplay(effective) : undefined,
			route?.thinking,
		));
		pendingNote = {
			task: classification.task,
			model: effective ? modelDisplay(effective) : undefined,
			// Always the effective level: getThinkingLevel reflects the clamped,
			// actually-applied value whether or not this route set one.
			thinking: pi.getThinkingLevel(),
			matched: classification.matched,
		};
		return true;
	}

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const text = event.text.trim();
		if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
		// Selecting the dialer at startup (pi --model dialer/pi-dialer) fires no
		// model_select event, so treat "the virtual model is active" as enable.
		if (!dialerOn && ctx.model?.provider === DIALER_PROVIDER) {
			dialerOn = true;
			persistState(true);
		}
		if (!dialerOn) return { action: "continue" };
		if (!(await applyRoute(text, ctx))) return { action: "handled" };
		return { action: "continue" };
	});

	// Skill and prompt-template commands ("/wraiter …") slip past the input
	// handler — it skips all /-commands because most don't stream — but their
	// expansion runs the agent like a normal prompt. before_agent_start fires
	// with the expanded text right before the agent loop, so route here if the
	// virtual model is still what's selected. Ordinary routed prompts are
	// already on a real model by now, making this a no-op. This event cannot
	// block the run; if no real model resolves, the virtual model's error
	// stream is the last resort.
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.model?.provider !== DIALER_PROVIDER) return;
		if (!dialerOn) {
			dialerOn = true;
			persistState(true);
		}
		await applyRoute(event.prompt, ctx);
	});

	// Stamp the routing decision under the final assistant response of a routed
	// prompt (same message_end append pattern as pi-read-coverage).
	pi.on("message_end", (event) => {
		if (!pendingNote) return;
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "toolUse") return;
		const footer = formatRouteFooter(pendingNote);
		pendingNote = undefined;

		const message = { ...event.message, content: [...event.message.content] };
		for (let i = message.content.length - 1; i >= 0; i--) {
			const part = message.content[i];
			if (part.type === "text") {
				message.content[i] = { ...part, text: `${part.text}${footer}` };
				return { message };
			}
		}
		message.content.push({ type: "text", text: footer.trimStart() });
		return { message };
	});

	// Clear the stamp backstop and park back on the virtual model so the
	// footer reads "pi-dialer" between prompts while the dialer is on.
	pi.on("agent_end", async (_event, ctx) => {
		pendingNote = undefined;
		if (dialerOn) await parkOnDialer(ctx);
	});

	// Manual /compact and threshold auto-compaction both run while parked on
	// the virtual model (auto-compaction fires after agent_end has parked), so
	// produce the compaction against a real model here.
	pi.on("session_before_compact", async (event, ctx) =>
		dialerCompaction(event, {
			parked: ctx.model?.provider === DIALER_PROVIDER,
			model: fallbackRealModel(ctx),
			getAuth: (model) => ctx.modelRegistry.getApiKeyAndHeaders(model),
			compactFn: compact,
			notify: (message, level) => ctx.ui.notify(message, level),
		}));

	pi.registerCommand("dialer", {
		description: "Dialer routing: /dialer on | off | status | use <setup> | save <setup> (no arg toggles)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim().toLowerCase();
			if (trimmed === "use" || trimmed.startsWith("use ")) {
				const namePrefix = prefix.trim().slice(3).trim().toLowerCase();
				const names = [...Object.keys(loadGlobalConfig().config.setups ?? {}).sort(), "none"];
				const items = names
					.filter((n) => n.toLowerCase().startsWith(namePrefix))
					.map((n) => ({
						value: `use ${n}`,
						label: `use ${n}`,
						description: n === "none" ? "Back to the top-level routes" : "Activate this setup",
					}));
				return items.length > 0 ? items : null;
			}
			const items: AutocompleteItem[] = [
				{ value: "on", label: "on", description: "Route every prompt by task type" },
				{ value: "off", label: "off", description: "Stop routing; keep the current model" },
				{ value: "status", label: "status", description: "Show routes and state" },
				{ value: "use ", label: "use <setup>", description: "Activate a named setup" },
				{ value: "save ", label: "save <setup>", description: "Save current routes as a named setup" },
			];
			const filtered = items.filter((i) => i.value.trim().startsWith(trimmed));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const command = parseDialerCommand(args);
			if (command.kind === "error") {
				emit(ctx, command.message, "warning");
				return;
			}
			if (command.kind === "status") {
				await showStatus(ctx);
				return;
			}
			if (command.kind === "use") {
				await useSetup(ctx, command.name);
				return;
			}
			if (command.kind === "save") {
				await saveSetup(ctx, command.name);
				return;
			}
			const next = command.kind === "toggle" ? !dialerOn : command.kind === "on";
			if (next === dialerOn) {
				emit(ctx, dialerOn ? "Dialer is already on." : "Dialer is already off.", "info");
				return;
			}
			dialerOn = next;
			persistState(next);
			// Keep the footer's model display in sync: park on the virtual model
			// while on, return to a real model when turning off.
			if (next) await parkOnDialer(ctx);
			else await unparkFromDialer(ctx);
			updateStatus(ctx);
			emit(ctx, next ? "Dialer on: prompts now pick the model and thinking level per task." : "Dialer off.", "info");
		},
	});

	async function useSetup(ctx: ExtensionContext, name: string | undefined) {
		const global = loadGlobalConfig();
		const names = Object.keys(global.config.setups ?? {}).sort();
		if (!name) {
			if (names.length === 0) {
				emit(ctx, "No named setups saved. Save one with /dialer save <name>.", "info");
				return;
			}
			const active = global.config.activeSetup;
			const list = names.map((n) => (n === active ? `${n} (active)` : n)).join(", ");
			emit(ctx, `Setups: ${list}\nActivate one with /dialer use <name>.`, "info");
			return;
		}
		if (name === "none") {
			saveConfig(globalConfigPath(), deactivateSetup(global.config));
			updateStatus(ctx);
			emit(ctx, "Named setup deactivated; using the top-level routes.", "info");
			return;
		}
		const updated = activateSetup(global.config, name);
		if (!updated) {
			emit(ctx, `Setup "${name}" is not configured. Available: ${names.length ? names.join(", ") : "none"}.`, "warning");
			return;
		}
		saveConfig(globalConfigPath(), updated);
		updateStatus(ctx);
		const overrideNote = projectOverrideNote(ctx);
		emit(ctx, `Dialer setup "${name}" activated.${overrideNote}`, "info");
	}

	async function saveSetup(ctx: ExtensionContext, name: string | undefined) {
		if (!name) {
			emit(ctx, "Usage: /dialer save <name>", "warning");
			return;
		}
		if (name === "none") {
			emit(ctx, `"none" is reserved (used by /dialer use none); pick another setup name.`, "warning");
			return;
		}
		const global = loadGlobalConfig();
		const updated = saveSetupSnapshot(global.config, name);
		saveConfig(globalConfigPath(), updated);
		updateStatus(ctx);
		emit(ctx, `Saved current routes as setup "${name}" and activated it.`, "info");
	}

	function projectOverrideNote(ctx: ExtensionContext): string {
		const projectPath = projectConfigPath(ctx.cwd);
		return ctx.isProjectTrusted() && existsSync(projectPath)
			? `\nNote: ${projectPath} exists and overrides the global config in this project.`
			: "";
	}

	pi.registerCommand("dialer-status", {
		description: "Show dialer state, config source, and the resolved routes",
		handler: async (_args, ctx) => showStatus(ctx),
	});

	pi.registerCommand("dialer-setup", {
		description: "Pick a model and thinking level per task type (writes the global dialer.json)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("dialer-setup requires interactive mode. Edit dialer.json directly (see /dialer-init).", "error");
				return;
			}
			const available = ctx.modelRegistry
				.getAvailable()
				.filter((m) => m.provider !== DIALER_PROVIDER && m.input.includes("text"));
			if (available.length === 0) {
				ctx.ui.notify("No authed text models available.", "error");
				return;
			}

			// Setup edits and persists the GLOBAL config; a trusted project's
			// .pi/dialer.json (if present) still overrides it at routing time.
			const global = loadGlobalConfig();
			const rows: SetupRow[] = resolveRoutes(global.config).map((r) => ({
				task: r.task,
				model: r.model,
				thinking: r.thinking,
			}));

			const result = await selectDialerSetup(ctx, available, rows);
			if (!result) {
				ctx.ui.notify("Dialer setup cancelled", "info");
				return;
			}

			const selections: RouteSelections = {};
			for (const row of result) {
				selections[row.task] = { model: row.model, thinking: row.thinking };
			}
			const merged = mergeRouteSelections(global.config, selections);
			saveConfig(globalConfigPath(), merged);

			const setupName = effectiveSetup(global.config).setupName;
			const summary = result
				.map((r) => `${r.task}: ${rowModelLabel(r.model)} · thinking ${thinkingLabel(r.thinking)}`)
				.join("\n");
			const target = setupName ? `setup "${setupName}" in ${globalConfigPath()}` : globalConfigPath();
			updateStatus(ctx);
			ctx.ui.notify(`Saved to ${target}\n${summary}${projectOverrideNote(ctx)}`, "info");
		},
	});

	pi.registerCommand("dialer-init", {
		description: "Create a project-local .pi/dialer.json template",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Project is not trusted; cannot write project-local config", "error");
				return;
			}
			const configPath = projectConfigPath(ctx.cwd);
			// Seed the template from actually-authed models so it works immediately.
			const authed = ctx.modelRegistry
				.getAvailable()
				.filter((m) => m.provider !== DIALER_PROVIDER && m.input.includes("text"))
				.map(modelDisplay);
			const example = generateConfigExample(authed);

			if (existsSync(configPath)) {
				const overwrite = await ctx.ui.confirm(
					".pi/dialer.json already exists",
					`Overwrite ${configPath} with the template?`,
				);
				if (!overwrite) {
					ctx.ui.notify("dialer-init cancelled", "info");
					return;
				}
			}
			saveConfig(configPath, example);

			const openConfig = await ctx.ui.confirm(
				"Created .pi/dialer.json",
				`Wrote template to ${configPath}. Open it in the editor to customize?`,
			);
			if (openConfig) {
				ctx.ui.setEditorText(JSON.stringify(example, null, 2));
			}
		},
	});

	async function showStatus(ctx: ExtensionCommandContext | ExtensionContext) {
		const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const routes = resolveRoutes(loaded.config);
		const setup = effectiveSetup(loaded.config);
		const setupNames = Object.keys(loaded.config.setups ?? {}).sort();
		const lines: string[] = [];
		lines.push(`Dialer: ${dialerOn ? "on" : "off"}`);
		lines.push(loaded.path ? `Config: ${loaded.path}` : "Config: none (run /dialer-setup or /dialer-init)");
		if (setup.setupName) lines.push(`Setup: ${setup.setupName}`);
		else if (setupNames.length > 0) lines.push("Setup: none (top-level routes)");
		if (setupNames.length > 0) lines.push(`Setups available: ${setupNames.join(", ")}  (/dialer use <name>)`);
		for (const warning of loaded.warnings) lines.push(`Warning: ${warning}`);
		if (setup.warning) lines.push(`Warning: ${setup.warning}`);
		lines.push("");
		for (const route of routes) {
			const keywords = route.task === DEFAULT_TASK
				? "fallback when nothing matches"
				: `${route.keywords.length} keywords`;
			lines.push(`${route.task}: ${rowModelLabel(route.model)} · thinking ${thinkingLabel(route.thinking)} · ${keywords}`);
		}
		lines.push("");
		lines.push("Select the Pi Dialer model or use /dialer on to start routing. /dialer-setup to configure.");
		updateStatus(ctx);
		emit(ctx, lines.join("\n"), "info");
	}

	function emit(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
		if (ctx.mode === "print") console.log(message);
		else ctx.ui.notify(message, level);
	}

	const restore = async (ctx: ExtensionContext) => {
		dialerOn = restoreState(ctx) ?? false;
		// The dialer model can be active at startup (pi --model dialer/pi-dialer)
		// without a model_select event: treat that as enable.
		if (!dialerOn && ctx.model?.provider === DIALER_PROVIDER) {
			dialerOn = true;
			persistState(true);
		}
		// Keep the footer display consistent with the restored state.
		if (dialerOn) await parkOnDialer(ctx);
		updateStatus(ctx);
	};
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
}
