/**
 * Tests for pi-dialer command parsing and status text helpers.
 */

import { dialerStatusText, formatRouteFooter, parseDialerCommand, routeNote } from "../index.ts";
import { eq, test } from "./_harness.ts";

test("parseDialerCommand maps arguments", () => {
	eq(parseDialerCommand("").kind, "toggle", "empty toggles");
	eq(parseDialerCommand("  ").kind, "toggle", "whitespace toggles");
	eq(parseDialerCommand("on").kind, "on", "on");
	eq(parseDialerCommand("ON").kind, "on", "case-insensitive");
	eq(parseDialerCommand("enable").kind, "on", "enable alias");
	eq(parseDialerCommand("off").kind, "off", "off");
	eq(parseDialerCommand("disable").kind, "off", "disable alias");
	eq(parseDialerCommand("status").kind, "status", "status");
});

test("parseDialerCommand rejects unknown arguments", () => {
	const result = parseDialerCommand("bogus");
	eq(result.kind, "error", "error kind");
	if (result.kind === "error" && !result.message.includes("bogus")) {
		throw new Error("error message should quote the argument");
	}
});

test("parseDialerCommand parses use and save with optional names", () => {
	eq(parseDialerCommand("use quality"), { kind: "use", name: "quality" }, "use with name");
	eq(parseDialerCommand("use"), { kind: "use", name: undefined }, "use without name lists");
	eq(parseDialerCommand("USE Quality"), { kind: "use", name: "Quality" }, "name keeps its case");
	eq(parseDialerCommand("save cheap"), { kind: "save", name: "cheap" }, "save with name");
	eq(parseDialerCommand("save"), { kind: "save", name: undefined }, "save without name errors later");
});

test("dialerStatusText clears when off and annotates routes when on", () => {
	eq(dialerStatusText(false), undefined, "off clears status");
	eq(dialerStatusText(true), "Dialer: on", "on without route");
	eq(dialerStatusText(true, "plan → openai/gpt-4.1 (high)"), "Dialer: plan → openai/gpt-4.1 (high)", "route note");
	eq(dialerStatusText(true, undefined, "quality"), "Dialer [quality]: on", "active setup shown");
	eq(dialerStatusText(false, undefined, "quality"), undefined, "off still clears with setup");
});

test("formatRouteFooter shows task, model, thinking, and matched keywords", () => {
	const footer = formatRouteFooter({
		task: "quick-edit",
		model: "openai/gpt-4.1-mini",
		thinking: "off",
		matched: ["rename", "move the file"],
	});
	eq(
		footer,
		'\n\n---\n_Dialer: quick-edit → openai/gpt-4.1-mini · thinking off · matched: "rename", "move the file"_',
		"full footer",
	);
});

test("formatRouteFooter truncates long keyword lists and handles no match", () => {
	const many = formatRouteFooter({
		task: "plan",
		model: "m",
		thinking: "high",
		matched: ["a", "b", "c", "d", "e"],
	});
	if (!many.includes('"a", "b", "c", "d", …')) throw new Error(`expected truncated list, got: ${many}`);
	const none = formatRouteFooter({ task: "default", model: undefined, thinking: undefined, matched: [] });
	if (!none.includes("default → current model · thinking keep · no keyword match")) {
		throw new Error(`expected fallback footer, got: ${none}`);
	}
});

test("routeNote formats task, model, and thinking", () => {
	eq(routeNote("plan", "openai/gpt-4.1", "high"), "plan → openai/gpt-4.1 (high)", "full note");
	eq(routeNote("default", undefined, undefined), "default → current model", "model-less note");
	eq(routeNote("quick-edit", "openai/gpt-4.1-mini", undefined), "quick-edit → openai/gpt-4.1-mini", "thinking-less note");
});
