/**
 * Tests for keyword-based prompt classification.
 */

import { BUILTIN_KEYWORDS, classifyPrompt, DEFAULT_TASK, phraseRegex } from "../classify.ts";
import { resolveRoutes } from "../config.ts";
import { eq, test } from "./_harness.ts";

const DEFAULT_ROUTES = resolveRoutes({});

test("plan prompts classify as plan", () => {
	eq(classifyPrompt("Help me plan the migration to the new API", DEFAULT_ROUTES).task, "plan", "plan verb");
	eq(classifyPrompt("Think through the trade-offs of REST vs GraphQL", DEFAULT_ROUTES).task, "plan", "think through");
	eq(classifyPrompt("Should we adopt a monorepo?", DEFAULT_ROUTES).task, "plan", "should we");
});

test("implement prompts classify as implement", () => {
	eq(classifyPrompt("Implement pagination for the users endpoint", DEFAULT_ROUTES).task, "implement", "implement verb");
	eq(classifyPrompt("Add support for dark mode", DEFAULT_ROUTES).task, "implement", "add support");
});

test("deep-dive prompts classify as deep-dive", () => {
	eq(classifyPrompt("Explain how the session manager works", DEFAULT_ROUTES).task, "deep-dive", "explain");
	eq(classifyPrompt("Do a deep dive on the auth flow", DEFAULT_ROUTES).task, "deep-dive", "deep dive");
	eq(classifyPrompt("How does the retry logic handle timeouts?", DEFAULT_ROUTES).task, "deep-dive", "how does");
});

test("quick-edit prompts classify as quick-edit", () => {
	eq(classifyPrompt("Rename utils.ts to helpers.ts", DEFAULT_ROUTES).task, "quick-edit", "rename");
	eq(classifyPrompt("Move the file into src/lib", DEFAULT_ROUTES).task, "quick-edit", "move the file");
	eq(classifyPrompt("There's a typo in the README", DEFAULT_ROUTES).task, "quick-edit", "typo");
});

test("longer phrases outweigh single words across routes", () => {
	// "fix" alone is implement; "quick fix" (2 words) must beat it.
	eq(classifyPrompt("Just a quick fix for the header", DEFAULT_ROUTES).task, "quick-edit", "quick fix beats fix");
});

test("unmatched prompts fall back to the default task", () => {
	const result = classifyPrompt("hello there", DEFAULT_ROUTES);
	eq(result.task, DEFAULT_TASK, "fallback task");
	eq(result.score, 0, "fallback score");
});

test("word boundaries prevent substring matches", () => {
	// "planet" must not match the "plan" keyword.
	eq(classifyPrompt("Tell me about the planet Mars", DEFAULT_ROUTES).task, DEFAULT_TASK, "planet is not plan");
	eq(phraseRegex("plan").test("replanning"), false, "no substring match inside words");
});

test("matched keywords are reported", () => {
	const result = classifyPrompt("Implement the feature", DEFAULT_ROUTES);
	if (!result.matched.includes("implement")) throw new Error(`missing matched keyword: ${JSON.stringify(result.matched)}`);
	if (!result.matched.includes("feature")) throw new Error(`missing matched keyword: ${JSON.stringify(result.matched)}`);
});

test("config keywords replace built-ins for that route", () => {
	const routes = resolveRoutes({ routes: { plan: { keywords: ["ponder"] } } });
	eq(classifyPrompt("Let me ponder this", routes).task, "plan", "custom keyword routes to plan");
	// The built-in "roadmap" was replaced, so it no longer matches plan.
	eq(classifyPrompt("Show the roadmap", routes).task, DEFAULT_TASK, "replaced keywords are gone");
});

test("custom task types participate and win ties by config order", () => {
	const routes = resolveRoutes({
		routes: {
			research: { keywords: ["benchmark"], model: "openai/gpt-4.1" },
		},
	});
	eq(classifyPrompt("Run a benchmark comparison", routes).task, "research", "custom task matches");
});

test("ties keep the earliest route in resolved order", () => {
	const routes = resolveRoutes({
		routes: {
			a: { keywords: ["widget"] },
			b: { keywords: ["widget"] },
		},
	});
	eq(classifyPrompt("widget", routes).task, "a", "earlier config route wins the tie");
});

test("phraseRegex is case-insensitive and tolerant of extra whitespace", () => {
	if (!phraseRegex("deep dive").test("DEEP   DIVE now")) throw new Error("expected whitespace-tolerant match");
});

test("every built-in keyword list is non-empty", () => {
	for (const [task, keywords] of Object.entries(BUILTIN_KEYWORDS)) {
		if (keywords.length === 0) throw new Error(`built-in task ${task} has no keywords`);
	}
});
