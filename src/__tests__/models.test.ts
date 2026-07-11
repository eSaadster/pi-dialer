/**
 * Tests for model identifier resolution.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { modelDisplay, resolveModelIdentifier, sameModel } from "../models.ts";
import type { Api, Model } from "../types.ts";
import { eq, fakeModel, test } from "./_harness.ts";

function fakeRegistry(models: Model<Api>[]): ModelRegistry {
	return {
		getAll: () => models,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

const MODELS = [
	fakeModel("anthropic", "claude-sonnet-4-5"),
	fakeModel("openai", "gpt-4.1"),
];

test("modelDisplay formats provider/id", () => {
	eq(modelDisplay(fakeModel("anthropic", "claude-sonnet-4-5")), "anthropic/claude-sonnet-4-5", "display");
});

test("resolveModelIdentifier resolves provider/id form", () => {
	const model = resolveModelIdentifier(fakeRegistry(MODELS), "openai/gpt-4.1");
	eq(model?.id, "gpt-4.1", "resolved by provider/id");
});

test("resolveModelIdentifier resolves bare ids across providers", () => {
	const model = resolveModelIdentifier(fakeRegistry(MODELS), "claude-sonnet-4-5");
	eq(model?.provider, "anthropic", "resolved by bare id");
});

test("resolveModelIdentifier returns undefined for unknown ids", () => {
	eq(resolveModelIdentifier(fakeRegistry(MODELS), "nope/nothing"), undefined, "unknown provider/id");
	eq(resolveModelIdentifier(fakeRegistry(MODELS), "nothing"), undefined, "unknown bare id");
});

test("sameModel compares provider and id", () => {
	eq(sameModel(MODELS[0], fakeModel("anthropic", "claude-sonnet-4-5")), true, "same");
	eq(sameModel(MODELS[0], MODELS[1]), false, "different");
	eq(sameModel(undefined, MODELS[0]), false, "undefined lhs");
});
