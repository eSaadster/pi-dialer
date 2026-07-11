/**
 * Tests for dialer config validation, route resolution, and setup merging.
 */

import { BUILTIN_KEYWORDS, BUILTIN_TASKS, DEFAULT_TASK } from "../classify.ts";
import {
	activateSetup,
	deactivateSetup,
	effectiveSetup,
	generateConfigExample,
	mergeRouteSelections,
	resolveRoutes,
	saveSetupSnapshot,
	validateConfig,
} from "../config.ts";
import { eq, test } from "./_harness.ts";

test("validateConfig accepts a well-formed config", () => {
	const { config, warnings } = validateConfig({
		routes: {
			plan: { keywords: ["ponder"], model: "openai/gpt-4.1", thinking: "high" },
		},
	});
	eq(warnings.length, 0, "no warnings");
	eq(config.routes?.plan.model, "openai/gpt-4.1", "model kept");
	eq(config.routes?.plan.thinking, "high", "thinking kept");
});

test("validateConfig rejects a non-object root", () => {
	const { config, warnings } = validateConfig([1, 2, 3]);
	eq(config, {}, "empty config");
	eq(warnings.length, 1, "one warning");
});

test("validateConfig drops invalid fields with warnings but keeps the rest", () => {
	const { config, warnings } = validateConfig({
		routes: {
			plan: { keywords: "not-an-array", model: "  ", thinking: "ultra" },
			implement: { model: "anthropic/claude-sonnet-4-5" },
		},
	});
	eq(config.routes?.plan.keywords, undefined, "bad keywords dropped");
	eq(config.routes?.plan.model, undefined, "bad model dropped");
	eq(config.routes?.plan.thinking, undefined, "bad thinking dropped");
	eq(config.routes?.implement.model, "anthropic/claude-sonnet-4-5", "valid sibling kept");
	eq(warnings.length, 3, "three warnings");
});

test("resolveRoutes includes all built-ins plus default when config is empty", () => {
	const routes = resolveRoutes({});
	eq(routes.map((r) => r.task), [...BUILTIN_TASKS, DEFAULT_TASK], "built-in order then default");
	eq(routes[0].keywords, [...BUILTIN_KEYWORDS.plan], "built-in keywords applied");
	eq(routes[routes.length - 1].keywords, [], "default has no keywords");
});

test("resolveRoutes puts config routes first in config order", () => {
	const routes = resolveRoutes({
		routes: {
			research: { keywords: ["benchmark"] },
			"quick-edit": { model: "openai/gpt-4.1-mini" },
		},
	});
	eq(routes.map((r) => r.task), ["research", "quick-edit", "plan", "implement", "deep-dive", DEFAULT_TASK], "config order first");
	eq(routes[1].keywords, [...BUILTIN_KEYWORDS["quick-edit"]], "built-in keywords survive when config omits them");
	eq(routes[1].model, "openai/gpt-4.1-mini", "config model applied");
});

test("resolveRoutes keeps default last even when configured", () => {
	const routes = resolveRoutes({
		routes: {
			default: { model: "anthropic/claude-sonnet-4-5", thinking: "medium", keywords: ["ignored"] },
		},
	});
	const last = routes[routes.length - 1];
	eq(last.task, DEFAULT_TASK, "default last");
	eq(last.model, "anthropic/claude-sonnet-4-5", "default model kept");
	eq(last.keywords, [], "default never carries keywords");
});

test("mergeRouteSelections preserves keywords and untouched routes", () => {
	const config = {
		routes: {
			plan: { keywords: ["ponder"], model: "old/model", thinking: "low" as const },
			research: { keywords: ["benchmark"], model: "openai/gpt-4.1" },
		},
	};
	const merged = mergeRouteSelections(config, {
		plan: { model: "anthropic/claude-opus-4-5", thinking: "high" },
	});
	eq(merged.routes?.plan.keywords, ["ponder"], "keywords preserved");
	eq(merged.routes?.plan.model, "anthropic/claude-opus-4-5", "model updated");
	eq(merged.routes?.plan.thinking, "high", "thinking updated");
	eq(merged.routes?.research.model, "openai/gpt-4.1", "untouched route preserved");
});

test("mergeRouteSelections removes model/thinking when unset", () => {
	const config = {
		routes: { plan: { keywords: ["ponder"], model: "old/model", thinking: "low" as const } },
	};
	const merged = mergeRouteSelections(config, { plan: {} });
	eq(merged.routes?.plan.model, undefined, "model removed");
	eq(merged.routes?.plan.thinking, undefined, "thinking removed");
	eq(merged.routes?.plan.keywords, ["ponder"], "keywords still preserved");
});

test("generateConfigExample validates cleanly and seeds provided models", () => {
	const example = generateConfigExample(["p1/m1", "p2/m2", "p3/m3"]);
	const { warnings } = validateConfig(JSON.parse(JSON.stringify(example)));
	eq(warnings.length, 0, "example is valid");
	eq(example.routes?.plan.model, "p1/m1", "first model seeds plan");
	eq(example.routes?.implement.model, "p2/m2", "second model seeds implement");
	eq(example.routes?.["quick-edit"].model, "p3/m3", "third model seeds quick-edit");
});

test("generateConfigExample falls back to placeholders without models", () => {
	const example = generateConfigExample();
	if (!example.routes?.plan.model) throw new Error("expected placeholder plan model");
});

test("validateConfig accepts setups and activeSetup", () => {
	const { config, warnings } = validateConfig({
		activeSetup: "quality",
		setups: {
			quality: { routes: { plan: { model: "a/b", thinking: "high" } } },
			cheap: { routes: { plan: { model: "c/d" } } },
		},
	});
	eq(warnings.length, 0, "no warnings");
	eq(config.activeSetup, "quality", "activeSetup kept");
	eq(config.setups?.quality.routes?.plan.model, "a/b", "setup route kept");
});

test("validateConfig drops invalid setup fields with context in warnings", () => {
	const { config, warnings } = validateConfig({
		activeSetup: "  ",
		setups: { broken: { routes: { plan: { thinking: "ultra" } } }, list: [1] },
	});
	eq(config.activeSetup, undefined, "blank activeSetup dropped");
	eq(config.setups?.broken.routes?.plan.thinking, undefined, "bad thinking dropped");
	eq(config.setups?.list, undefined, "non-object setup dropped");
	if (!warnings.some((w) => w.includes('setup "broken"'))) throw new Error(`missing setup context: ${warnings}`);
});

test("effectiveSetup picks the active setup and falls back with a warning", () => {
	const config = {
		routes: { plan: { model: "top/level" } },
		setups: { quality: { routes: { plan: { model: "setup/model" } } } },
	};
	eq(effectiveSetup(config).routes.plan.model, "top/level", "no active setup uses top-level");
	eq(effectiveSetup({ ...config, activeSetup: "quality" }).routes.plan.model, "setup/model", "active setup wins");
	const missing = effectiveSetup({ ...config, activeSetup: "gone" });
	eq(missing.routes.plan.model, "top/level", "unknown setup falls back");
	if (!missing.warning?.includes('"gone"')) throw new Error("expected fallback warning");
});

test("resolveRoutes uses the active setup's routes", () => {
	const routes = resolveRoutes({
		activeSetup: "cheap",
		routes: { plan: { model: "top/level" } },
		setups: { cheap: { routes: { plan: { model: "cheap/model", thinking: "low" } } } },
	});
	eq(routes[0].task, "plan", "plan first");
	eq(routes[0].model, "cheap/model", "setup model used");
	eq(routes[0].thinking, "low", "setup thinking used");
});

test("mergeRouteSelections edits the active setup when one is active", () => {
	const config = {
		activeSetup: "quality",
		routes: { plan: { model: "top/level" } },
		setups: { quality: { routes: { plan: { keywords: ["ponder"], model: "old/model" } } } },
	};
	const merged = mergeRouteSelections(config, { plan: { model: "new/model", thinking: "high" } });
	eq(merged.setups?.quality.routes?.plan.model, "new/model", "setup route updated");
	eq(merged.setups?.quality.routes?.plan.keywords, ["ponder"], "setup keywords preserved");
	eq(merged.routes?.plan.model, "top/level", "top-level routes untouched");
});

test("saveSetupSnapshot copies effective routes into a named setup and activates it", () => {
	const config = { routes: { plan: { model: "top/level", thinking: "high" as const } } };
	const saved = saveSetupSnapshot(config, "mine");
	eq(saved.activeSetup, "mine", "snapshot activated");
	eq(saved.setups?.mine.routes?.plan.model, "top/level", "routes copied");
	// Snapshot is a deep copy: editing it later must not touch the source.
	saved.setups!.mine.routes!.plan.model = "changed";
	eq(config.routes.plan.model, "top/level", "source unchanged");
});

test("activateSetup and deactivateSetup", () => {
	const config = { setups: { a: {} }, routes: {} };
	eq(activateSetup(config, "a")?.activeSetup, "a", "activates known setup");
	eq(activateSetup(config, "b"), undefined, "unknown setup rejected");
	const active = { ...config, activeSetup: "a" };
	eq(deactivateSetup(active).activeSetup, undefined, "deactivated");
});
