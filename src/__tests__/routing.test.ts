/**
 * Routing tests driving the extension entry point with a fake pi API. Focus:
 * skill/prompt-template commands ("/wraiter …") skip the input handler (all
 * /-commands do) but stream like normal prompts, so the before_agent_start
 * backstop must route their expanded text off the parked virtual model.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { DIALER_MODEL_ID, DIALER_PROVIDER } from "../index.ts";
import type { Api, Model } from "../types.ts";
import { eq, fakeModel, test } from "./_harness.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/**
 * A fresh extension instance wired to fakes. Each test builds its own so the
 * harness's fire-and-forget async tests cannot share mutable state. Routes
 * come from a temp project config (a trusted project's file wins whole, so
 * the developer's real global dialer.json never leaks in).
 */
function makeHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-dialer-routing-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "dialer.json"),
		JSON.stringify({
			routes: {
				implement: { model: "openai/gpt-impl", keywords: ["implement"] },
				default: { model: "openai/gpt-base" },
			},
		}),
	);

	const models: Model<Api>[] = [fakeModel("openai", "gpt-impl"), fakeModel("openai", "gpt-base")];
	const handlers = new Map<string, Handler>();
	const setModelCalls: string[] = [];
	const notifications: string[] = [];
	let current: Model<Api> | undefined;

	const pi = {
		registerProvider: (name: string, config: { models: Array<{ id: string }> }) => {
			for (const m of config.models) models.push(fakeModel(name, m.id));
		},
		registerCommand: () => {},
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		appendEntry: () => {},
		setModel: async (model: Model<Api>) => {
			current = model;
			setModelCalls.push(`${model.provider}/${model.id}`);
			return true;
		},
		setThinkingLevel: () => {},
		getThinkingLevel: () => "medium",
	};

	const ctx = {
		get model() {
			return current;
		},
		cwd,
		isProjectTrusted: () => true,
		mode: "interactive",
		hasUI: true,
		modelRegistry: {
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getAll: () => models,
			getAvailable: () => models,
			hasConfiguredAuth: () => true,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
		},
		sessionManager: { getBranch: () => [] },
	};

	extension(pi as never);
	const virtual = models.find((m) => m.provider === DIALER_PROVIDER && m.id === DIALER_MODEL_ID);
	if (!virtual) throw new Error("virtual dialer model was not registered");
	const base = models.find((m) => m.id === "gpt-base");

	return {
		virtual,
		base,
		setModelCalls,
		notifications,
		current: () => current,
		setCurrent: (model: Model<Api>) => {
			current = model;
		},
		fire: (event: string, payload: unknown) => {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`no handler registered for ${event}`);
			return Promise.resolve(handler(payload, ctx));
		},
		/** Turn the dialer on the way a user does: by picking the virtual model. */
		async parkOn() {
			current = virtual;
			await this.fire("model_select", { model: virtual, previousModel: base, source: "set" });
		},
	};
}

test("input handler skips /-commands, before_agent_start routes the expansion", async () => {
	const h = makeHarness();
	await h.parkOn();
	const result = await h.fire("input", { source: "user", text: "/wraiter do a pass over the content" });
	eq(result, { action: "continue" }, "slash input passes through unrouted");
	eq(h.setModelCalls, [], "input handler must not switch for /-commands");

	await h.fire("before_agent_start", { prompt: "expanded skill body: implement the requested pass" });
	eq(h.setModelCalls, ["openai/gpt-impl"], "expanded prompt classified and routed");
	eq(h.current()?.provider !== DIALER_PROVIDER, true, "a real model streams the skill run");
});

test("before_agent_start falls back to the default route when nothing matches", async () => {
	const h = makeHarness();
	await h.parkOn();
	await h.fire("before_agent_start", { prompt: "completely unmatched skill text" });
	eq(h.setModelCalls, ["openai/gpt-base"], "default route model used");
});

test("before_agent_start is a no-op when a real model is already active", async () => {
	const h = makeHarness();
	await h.parkOn();
	if (!h.base) throw new Error("missing base model");
	// A routed prompt already switched (self-switch does not fire model_select
	// back through the harness, so set directly).
	h.setCurrent(h.base);
	await h.fire("before_agent_start", { prompt: "implement something" });
	eq(h.setModelCalls, [], "no extra switch when not parked");
});

test("skill runs stamped like routed prompts via message_end", async () => {
	const h = makeHarness();
	await h.parkOn();
	await h.fire("before_agent_start", { prompt: "please implement the skill instructions" });
	const stamped = (await h.fire("message_end", {
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
	})) as { message: { content: Array<{ type: string; text: string }> } };
	const text = stamped.message.content[0].text;
	if (!text.includes("Dialer: implement → openai/gpt-impl")) {
		throw new Error(`expected route stamp on skill response, got: ${text}`);
	}
});

test("normal prompts still route through the input handler", async () => {
	const h = makeHarness();
	await h.parkOn();
	const result = await h.fire("input", { source: "user", text: "implement a new parser" });
	eq(result, { action: "continue" }, "prompt continues");
	eq(h.setModelCalls, ["openai/gpt-impl"], "input handler routed the prompt");
});
