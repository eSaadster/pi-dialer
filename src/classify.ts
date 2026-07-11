/**
 * Keyword-based prompt classification for pi-dialer.
 *
 * Pure functions: given a prompt and the resolved routes, pick the task type
 * whose keyword phrases match best. Multi-word phrases score higher than
 * single words (score = word count per matched phrase, summed per route), so
 * "quick fix" (quick-edit) beats "fix" (implement). Ties go to the route that
 * appears earlier in the resolved route order (config order first, then the
 * remaining built-ins). An LLM/eval-based classifier can slot in behind the
 * same `Classification` result shape later.
 */

import type { ResolvedRoute } from "./types.ts";

/** Canonical built-in task types, in tie-break order. */
export const BUILTIN_TASKS = ["plan", "implement", "deep-dive", "quick-edit"] as const;
export type BuiltinTask = (typeof BUILTIN_TASKS)[number];

/** Fallback task used when no keyword matches. Carries no keywords itself. */
export const DEFAULT_TASK = "default";

/**
 * Default keyword phrases per built-in task type. A route's `keywords` in
 * dialer.json replaces (not extends) this list for that task, so users can
 * see and prune exactly what triggers a route.
 */
export const BUILTIN_KEYWORDS: Record<BuiltinTask, readonly string[]> = {
	plan: [
		"plan",
		"plans",
		"planning",
		"plan out",
		"think through",
		"think about",
		"brainstorm",
		"design",
		"architect",
		"architecture",
		"approach",
		"strategy",
		"trade-off",
		"trade-offs",
		"tradeoff",
		"tradeoffs",
		"pros and cons",
		"should we",
		"should i",
		"evaluate",
		"roadmap",
		"proposal",
		"spec out",
		"outline",
	],
	implement: [
		"implement",
		"implementation",
		"build",
		"add",
		"create",
		"write",
		"develop",
		"code up",
		"wire up",
		"integrate",
		"feature",
		"refactor",
		"fix",
		"fix the bug",
		"add support",
	],
	"deep-dive": [
		"explain",
		"understand",
		"how does",
		"what does",
		"why does",
		"analyze",
		"analysis",
		"deep dive",
		"deep-dive",
		"dig into",
		"extract",
		"walk through",
		"walk me through",
		"investigate",
		"audit",
		"trace",
		"explore",
		"map out",
		"document",
		"summarize",
		"overview",
		"review",
	],
	"quick-edit": [
		"rename",
		"move",
		"move the file",
		"move a file",
		"delete",
		"remove",
		"typo",
		"tweak",
		"bump",
		"quick edit",
		"small edit",
		"small change",
		"quick change",
		"quick fix",
		"one-liner",
		"one liner",
		"copy",
		"duplicate",
		"reorder",
		"sort",
		"clean up",
		"cleanup",
		"format",
		"reformat",
		"mkdir",
		"chmod",
		"symlink",
	],
};

export interface Classification {
	task: string;
	score: number;
	/** Keyword phrases that matched, for /dialer-status style diagnostics. */
	matched: string[];
}

/** Compile a keyword phrase into a case-insensitive word-boundary regex. */
export function phraseRegex(phrase: string): RegExp {
	const escaped = phrase
		.trim()
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\s+/g, "\\s+");
	return new RegExp(`\\b${escaped}\\b`, "i");
}

function phraseWeight(phrase: string): number {
	return phrase.trim().split(/\s+/).length;
}

/**
 * Classify a prompt against the resolved routes. Routes are scored in order;
 * the highest score wins and ties keep the earliest route. When nothing
 * matches, the result is the `default` task with a zero score.
 */
export function classifyPrompt(text: string, routes: ResolvedRoute[]): Classification {
	let best: Classification = { task: DEFAULT_TASK, score: 0, matched: [] };
	for (const route of routes) {
		if (route.task === DEFAULT_TASK) continue;
		let score = 0;
		const matched: string[] = [];
		for (const keyword of route.keywords) {
			if (!keyword.trim()) continue;
			if (phraseRegex(keyword).test(text)) {
				score += phraseWeight(keyword);
				matched.push(keyword);
			}
		}
		if (score > best.score) {
			best = { task: route.task, score, matched };
		}
	}
	return best;
}
