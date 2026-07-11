/**
 * Model identifier resolution for pi-dialer.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "./types.ts";

export function modelDisplay(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function resolveModelIdentifier(registry: ModelRegistry, identifier: string): Model<Api> | undefined {
	const slash = identifier.indexOf("/");
	if (slash > 0) {
		const provider = identifier.slice(0, slash);
		const id = identifier.slice(slash + 1);
		return registry.find(provider, id);
	}
	// No provider prefix: search by exact id across all models.
	return registry.getAll().find((m) => m.id === identifier);
}

export function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}
