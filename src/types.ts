/**
 * Shared types for pi-dialer.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

export type { Api, Model };

/**
 * Provider-neutral thinking levels, matching pi's `ThinkingLevel` from
 * `@earendil-works/pi-agent-core` ("off" plus the pi-ai levels). pi clamps
 * unsupported levels to the model's capabilities in `setThinkingLevel`.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * One dial position in `dialer.json`: the keyword phrases that select it,
 * and the model + thinking level it routes to. All fields are optional —
 * omitted `keywords` fall back to the built-in defaults for that task type,
 * an omitted `model` keeps the currently selected model, and an omitted
 * `thinking` leaves the session's thinking level untouched.
 */
export interface RouteConfig {
	keywords?: string[];
	/** Model identifier in `provider/id` form (or a bare id matched across providers). */
	model?: string;
	thinking?: ThinkingLevel;
}

/** A named, switchable set of routes (`/dialer use <name>`). */
export interface DialerSetup {
	routes?: Record<string, RouteConfig>;
}

/** Root shape of `~/.pi/agent/dialer.json` / `<cwd>/.pi/dialer.json`. */
export interface DialerConfig {
	/** Top-level routes, used when no named setup is active. */
	routes?: Record<string, RouteConfig>;
	/** Named reusable route sets. */
	setups?: Record<string, DialerSetup>;
	/** Name of the setup in `setups` currently in effect. */
	activeSetup?: string;
}

/** A route after merging config with built-in task types and keywords. */
export interface ResolvedRoute {
	task: string;
	keywords: string[];
	model?: string;
	thinking?: ThinkingLevel;
}
