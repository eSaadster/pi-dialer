/**
 * Tests for the pure /dialer-setup helpers (the TUI rendering is not unit-tested).
 */

import { THINKING_LEVELS } from "../types.ts";
import { cycleThinking, rowModelLabel, thinkingLabel } from "../ui.ts";
import { eq, test } from "./_harness.ts";

test("cycleThinking walks keep → levels → keep", () => {
	eq(cycleThinking(undefined, 1), "off", "keep advances to off");
	eq(cycleThinking("off", 1), "minimal", "off advances to minimal");
	eq(cycleThinking("xhigh", 1), undefined, "last level wraps to keep");
	eq(cycleThinking(undefined, -1), "xhigh", "keep reverses to xhigh");
	eq(cycleThinking("off", -1), undefined, "off reverses to keep");
});

test("cycleThinking round-trips the whole cycle", () => {
	let level: ReturnType<typeof cycleThinking> = undefined;
	for (let i = 0; i < THINKING_LEVELS.length + 1; i++) level = cycleThinking(level, 1);
	eq(level, undefined, "full cycle returns to keep");
});

test("labels render unset values as keep/current", () => {
	eq(thinkingLabel(undefined), "keep", "thinking keep");
	eq(thinkingLabel("high"), "high", "thinking level");
	eq(rowModelLabel(undefined), "(keep current model)", "model keep");
	eq(rowModelLabel("openai/gpt-4.1"), "openai/gpt-4.1", "model id");
});
