/**
 * Tests for the session_before_compact handler logic: while parked on the
 * virtual model, compaction must run against a real model (pi would otherwise
 * summarize with the unstreamable dialer model), and failures must cancel
 * instead of falling through.
 */

import { dialerCompaction, type DialerCompactionDeps } from "../index.ts";
import { eq, fakeModel, test } from "./_harness.ts";

type Preparation = Parameters<DialerCompactionDeps["compactFn"]>[0];
type Compaction = Awaited<ReturnType<DialerCompactionDeps["compactFn"]>>;

const preparation = { firstKeptEntryId: "keep-1", tokensBefore: 1234 } as Preparation;
const result: Compaction = { summary: "a summary", firstKeptEntryId: "keep-1", tokensBefore: 1234 };

/** Deps for the happy path; individual tests override the piece under test. */
function fakeDeps(overrides: Partial<DialerCompactionDeps> = {}) {
	const notifications: string[] = [];
	const compactCalls: unknown[][] = [];
	const deps: DialerCompactionDeps = {
		parked: true,
		model: fakeModel("openai", "gpt-4.1"),
		getAuth: async () => ({ ok: true, apiKey: "key-1", headers: { "x-h": "1" } }),
		compactFn: async (...args: unknown[]) => {
			compactCalls.push(args);
			return result;
		},
		notify: (message) => notifications.push(message),
		...overrides,
	};
	return { deps, notifications, compactCalls };
}

function event(signal: AbortSignal = new AbortController().signal) {
	return { preparation, customInstructions: "focus on the bug", signal };
}

test("dialerCompaction passes through when a real model is selected", async () => {
	const { deps, compactCalls } = fakeDeps({ parked: false });
	eq(await dialerCompaction(event(), deps), undefined, "not parked defers to pi");
	eq(compactCalls.length, 0, "compact not called");
});

test("dialerCompaction compacts with the real model while parked", async () => {
	const { deps, notifications, compactCalls } = fakeDeps();
	const signal = new AbortController().signal;
	eq(await dialerCompaction(event(signal), deps), { compaction: result }, "returns the compaction");
	eq(compactCalls.length, 1, "compact called once");
	const [prep, model, apiKey, headers, instructions, passedSignal] = compactCalls[0];
	eq(prep, preparation, "preparation forwarded");
	eq((model as { id: string }).id, "gpt-4.1", "real model used");
	eq(apiKey, "key-1", "real model's api key used");
	eq(headers, { "x-h": "1" }, "real model's headers used");
	eq(instructions, "focus on the bug", "custom instructions forwarded");
	eq(passedSignal === signal, true, "abort signal forwarded");
	eq(notifications, [], "no notifications on success");
});

test("dialerCompaction cancels when no real model resolves", async () => {
	const { deps, notifications, compactCalls } = fakeDeps({ model: undefined });
	eq(await dialerCompaction(event(), deps), { cancel: true }, "cancels");
	eq(compactCalls.length, 0, "compact not called");
	eq(notifications.length, 1, "one notification");
	if (!notifications[0].includes("default")) {
		throw new Error(`notification should point at the default route: ${notifications[0]}`);
	}
});

test("dialerCompaction cancels when the real model's auth fails", async () => {
	const { deps, notifications, compactCalls } = fakeDeps({
		getAuth: async () => ({ ok: false, error: "no API key configured" }),
	});
	eq(await dialerCompaction(event(), deps), { cancel: true }, "cancels");
	eq(compactCalls.length, 0, "compact not called");
	eq(notifications.length, 1, "one notification");
	if (!notifications[0].includes("no API key configured")) {
		throw new Error(`notification should carry the auth error: ${notifications[0]}`);
	}
});

test("dialerCompaction cancels and notifies when compaction fails", async () => {
	const { deps, notifications } = fakeDeps({
		compactFn: async () => {
			throw new Error("boom from provider");
		},
	});
	eq(await dialerCompaction(event(), deps), { cancel: true }, "cancels");
	eq(notifications.length, 1, "one notification");
	if (!notifications[0].includes("boom from provider")) {
		throw new Error(`notification should carry the failure: ${notifications[0]}`);
	}
});

test("dialerCompaction stays quiet when compaction is aborted", async () => {
	const controller = new AbortController();
	const { deps, notifications } = fakeDeps({
		compactFn: async () => {
			controller.abort();
			throw new Error("aborted");
		},
	});
	eq(await dialerCompaction(event(controller.signal), deps), { cancel: true }, "cancels");
	eq(notifications, [], "no notification for an abort");
});
