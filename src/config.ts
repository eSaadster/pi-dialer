/**
 * Dialer configuration loading, validation, and persistence.
 *
 * Precedence: a trusted project's `.pi/dialer.json` wins over the global
 * `~/.pi/agent/dialer.json`; the first file found is used whole (no merging
 * between the two files). Within a file, each route merges
 * with the built-in defaults: omitted keywords fall back to the built-in
 * list for that task type.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILTIN_KEYWORDS, BUILTIN_TASKS, DEFAULT_TASK } from "./classify.ts";
import type { DialerConfig, DialerSetup, ResolvedRoute, RouteConfig, ThinkingLevel } from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";

export interface LoadedConfig {
	config: DialerConfig;
	/** Path the config was read from, or undefined when no file exists. */
	path?: string;
	warnings: string[];
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "dialer.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "dialer.json");
}

export function loadConfig(cwd: string, projectTrusted: boolean): LoadedConfig {
	const paths: string[] = [];
	if (projectTrusted) paths.push(projectConfigPath(cwd));
	paths.push(globalConfigPath());

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const { config, warnings } = validateConfig(JSON.parse(readFileSync(path, "utf8")));
			return { config, path, warnings };
		} catch (err) {
			return {
				config: {},
				path,
				warnings: [`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`],
			};
		}
	}
	return { config: {}, warnings: [] };
}

/** Validate an unknown parsed JSON value into a DialerConfig, collecting warnings for dropped fields. */
export function validateConfig(parsed: unknown): { config: DialerConfig; warnings: string[] } {
	const warnings: string[] = [];
	if (!isRecord(parsed)) {
		return { config: {}, warnings: ["Dialer config root must be a JSON object."] };
	}
	const config: DialerConfig = {};
	if (parsed.routes !== undefined) {
		const routes = validateRoutes(parsed.routes, "", warnings);
		if (routes) config.routes = routes;
	}
	if (parsed.setups !== undefined) {
		if (!isRecord(parsed.setups)) {
			warnings.push("`setups` must be an object; ignoring it.");
		} else {
			const setups: Record<string, DialerSetup> = {};
			for (const [name, value] of Object.entries(parsed.setups)) {
				if (!isRecord(value)) {
					warnings.push(`Setup "${name}" must be an object; ignoring it.`);
					continue;
				}
				const setup: DialerSetup = {};
				if (value.routes !== undefined) {
					const routes = validateRoutes(value.routes, `setup "${name}" `, warnings);
					if (routes) setup.routes = routes;
				}
				setups[name] = setup;
			}
			config.setups = setups;
		}
	}
	if (parsed.activeSetup !== undefined) {
		if (typeof parsed.activeSetup === "string" && parsed.activeSetup.trim().length > 0) {
			config.activeSetup = parsed.activeSetup.trim();
		} else {
			warnings.push("`activeSetup` must be a non-empty string; ignoring it.");
		}
	}
	return { config, warnings };
}

function validateRoutes(
	value: unknown,
	context: string,
	warnings: string[],
): Record<string, RouteConfig> | undefined {
	if (!isRecord(value)) {
		warnings.push(`${context}\`routes\` must be an object; ignoring it.`);
		return undefined;
	}
	const routes: Record<string, RouteConfig> = {};
	for (const [task, raw] of Object.entries(value)) {
		if (!isRecord(raw)) {
			warnings.push(`${context}route "${task}" must be an object; ignoring it.`);
			continue;
		}
		const route: RouteConfig = {};
		if (raw.keywords !== undefined) {
			if (Array.isArray(raw.keywords) && raw.keywords.every((k) => typeof k === "string")) {
				route.keywords = raw.keywords as string[];
			} else {
				warnings.push(`${context}route "${task}" keywords must be an array of strings; using built-in defaults.`);
			}
		}
		if (raw.model !== undefined) {
			if (typeof raw.model === "string" && raw.model.trim().length > 0) {
				route.model = raw.model.trim();
			} else {
				warnings.push(`${context}route "${task}" model must be a non-empty string; ignoring it.`);
			}
		}
		if (raw.thinking !== undefined) {
			if (isThinkingLevel(raw.thinking)) {
				route.thinking = raw.thinking;
			} else {
				warnings.push(
					`${context}route "${task}" thinking must be one of ${THINKING_LEVELS.join(", ")}; ignoring it.`,
				);
			}
		}
		routes[task] = route;
	}
	return routes;
}

/**
 * The routes currently in effect: the active setup's routes when `activeSetup`
 * names a configured setup, otherwise the top-level routes. An unknown active
 * setup warns and falls back to the top-level routes.
 */
export function effectiveSetup(config: DialerConfig): {
	routes: Record<string, RouteConfig>;
	setupName?: string;
	warning?: string;
} {
	if (config.activeSetup) {
		const setup = config.setups?.[config.activeSetup];
		if (setup) {
			return { routes: setup.routes ?? {}, setupName: config.activeSetup };
		}
		return {
			routes: config.routes ?? {},
			warning: `Active setup "${config.activeSetup}" is not configured; using the top-level routes.`,
		};
	}
	return { routes: config.routes ?? {} };
}

/**
 * Merge config routes with the built-in task types into the effective ordered
 * route list. Config-defined routes come first (in config key order — this is
 * the classification tie-break order), followed by any built-ins the config
 * did not mention. The `default` route always sorts last and never carries
 * keywords: it is the fallback when nothing matches.
 */
export function resolveRoutes(config: DialerConfig): ResolvedRoute[] {
	const configured = effectiveSetup(config).routes;
	const order: string[] = [];
	for (const task of Object.keys(configured)) {
		if (task !== DEFAULT_TASK) order.push(task);
	}
	for (const task of BUILTIN_TASKS) {
		if (!order.includes(task)) order.push(task);
	}

	const routes: ResolvedRoute[] = order.map((task) => {
		const route = configured[task] ?? {};
		const builtin = (BUILTIN_KEYWORDS as Record<string, readonly string[]>)[task];
		return {
			task,
			keywords: route.keywords ?? (builtin ? [...builtin] : []),
			model: route.model,
			thinking: route.thinking,
		};
	});

	const defaultRoute = configured[DEFAULT_TASK] ?? {};
	routes.push({
		task: DEFAULT_TASK,
		keywords: [],
		model: defaultRoute.model,
		thinking: defaultRoute.thinking,
	});
	return routes;
}

/** Model/thinking edits from /dialer-setup, keyed by task. */
export type RouteSelections = Record<string, { model?: string; thinking?: ThinkingLevel }>;

/**
 * Merge /dialer-setup selections into an existing config, preserving keywords
 * and any routes the setup did not touch. An unset model/thinking removes the
 * key so the route falls back to "keep current model" / "leave thinking
 * untouched". When a named setup is active, its routes are edited; otherwise
 * the top-level routes are.
 */
export function mergeRouteSelections(config: DialerConfig, selections: RouteSelections): DialerConfig {
	const { setupName } = effectiveSetup(config);
	if (setupName) {
		const setup = config.setups?.[setupName] ?? {};
		return {
			...config,
			setups: {
				...(config.setups ?? {}),
				[setupName]: { ...setup, routes: mergeRoutes(setup.routes ?? {}, selections) },
			},
		};
	}
	return { ...config, routes: mergeRoutes(config.routes ?? {}, selections) };
}

function mergeRoutes(
	base: Record<string, RouteConfig>,
	selections: RouteSelections,
): Record<string, RouteConfig> {
	const routes: Record<string, RouteConfig> = { ...base };
	for (const [task, selection] of Object.entries(selections)) {
		const existing: RouteConfig = { ...(routes[task] ?? {}) };
		if (selection.model !== undefined) existing.model = selection.model;
		else delete existing.model;
		if (selection.thinking !== undefined) existing.thinking = selection.thinking;
		else delete existing.thinking;
		routes[task] = existing;
	}
	return routes;
}

/** Snapshot the currently effective routes into a named setup and activate it. */
export function saveSetupSnapshot(config: DialerConfig, name: string): DialerConfig {
	const { routes } = effectiveSetup(config);
	return {
		...config,
		setups: {
			...(config.setups ?? {}),
			[name]: { routes: structuredClone(routes) },
		},
		activeSetup: name,
	};
}

/** Activate a named setup. Returns undefined when the name is not configured. */
export function activateSetup(config: DialerConfig, name: string): DialerConfig | undefined {
	if (!config.setups || !Object.hasOwn(config.setups, name)) return undefined;
	return { ...config, activeSetup: name };
}

/** Deactivate any named setup, falling back to the top-level routes. */
export function deactivateSetup(config: DialerConfig): DialerConfig {
	const { activeSetup: _removed, ...rest } = config;
	return rest;
}

/** Write a config file, creating parent directories as needed. */
export function saveConfig(path: string, config: DialerConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Load only the global config file (for /dialer-setup, which persists globally). */
export function loadGlobalConfig(): LoadedConfig {
	const path = globalConfigPath();
	if (!existsSync(path)) return { config: {}, warnings: [] };
	try {
		const { config, warnings } = validateConfig(JSON.parse(readFileSync(path, "utf8")));
		return { config, path, warnings };
	} catch (err) {
		return {
			config: {},
			path,
			warnings: [`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`],
		};
	}
}

/** Template written by /dialer-init, seeded with the user's models when available. */
export function generateConfigExample(models: string[] = []): DialerConfig {
	const pick = (i: number, fallback: string) => models[i] ?? models[0] ?? fallback;
	return {
		routes: {
			plan: {
				keywords: [...BUILTIN_KEYWORDS.plan],
				model: pick(0, "anthropic/claude-opus-4-5"),
				thinking: "high",
			},
			implement: {
				keywords: [...BUILTIN_KEYWORDS.implement],
				model: pick(1, "anthropic/claude-sonnet-4-5"),
				thinking: "medium",
			},
			"deep-dive": {
				keywords: [...BUILTIN_KEYWORDS["deep-dive"]],
				model: pick(0, "google/gemini-2.5-pro"),
				thinking: "high",
			},
			"quick-edit": {
				keywords: [...BUILTIN_KEYWORDS["quick-edit"]],
				model: pick(2, "openai/gpt-4.1-mini"),
				thinking: "low",
			},
			default: {
				model: pick(1, "anthropic/claude-sonnet-4-5"),
				thinking: "medium",
			},
		},
	};
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
