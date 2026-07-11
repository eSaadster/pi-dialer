/**
 * Native pi TUI for /dialer-setup.
 *
 * One screen with two modes: a task list (each row shows the routed model and
 * thinking level), and a model picker that assigns a model to the highlighted
 * task. Enter opens the picker · ←/→ or t cycles thinking · s saves · Esc
 * cancels (or backs out of the picker).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { modelDisplay } from "./models.ts";
import type { Api, Model, ThinkingLevel } from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";

/** One editable row in the setup screen. `model`/`thinking` unset = keep current. */
export interface SetupRow {
	task: string;
	model?: string;
	thinking?: ThinkingLevel;
}

/** Sentinel SelectList value for "keep the currently selected model". */
const KEEP_CURRENT = "__keep_current__";

/** Cycle order for the thinking column; undefined renders as "keep". */
const THINKING_CYCLE: (ThinkingLevel | undefined)[] = [undefined, ...THINKING_LEVELS];

/** Advance a thinking level through the cycle (undefined = leave untouched). */
export function cycleThinking(
	current: ThinkingLevel | undefined,
	dir: 1 | -1,
): ThinkingLevel | undefined {
	const i = THINKING_CYCLE.indexOf(current);
	const base = i < 0 ? 0 : i;
	return THINKING_CYCLE[(base + dir + THINKING_CYCLE.length) % THINKING_CYCLE.length];
}

/** Human label for a row's thinking value. */
export function thinkingLabel(level: ThinkingLevel | undefined): string {
	return level ?? "keep";
}

/** Human label for a row's model value. */
export function rowModelLabel(model: string | undefined): string {
	return model ?? "(keep current model)";
}

interface ModelInfo {
	identifier: string;
	provider: string;
	name: string;
}

function toModelInfo(available: Model<Api>[]): ModelInfo[] {
	return available.map((m) => ({
		identifier: modelDisplay(m),
		provider: m.provider,
		name: m.name,
	}));
}

function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return models;
	return models.filter(
		(m) =>
			m.name.toLowerCase().includes(trimmed) ||
			m.provider.toLowerCase().includes(trimmed) ||
			m.identifier.toLowerCase().includes(trimmed),
	);
}

/**
 * Replace a SelectList's items in place. pi-tui exposes no public `setItems()`, and `setFilter`
 * only prefix-matches `value`, so the picker (multi-field search) must write the private item
 * arrays. Guarded so a future pi-tui shape change fails LOUD rather than silently breaking the
 * picker. See docs/pi-api-notes.md.
 */
function setSelectListItems(list: SelectList, items: SelectItem[]): void {
	// pi gap: SelectList has no public setItems(); see docs/pi-api-notes.md.
	const internal = list as unknown as { items?: unknown; filteredItems?: unknown };
	if (!Array.isArray(internal.items) || !Array.isArray(internal.filteredItems)) {
		throw new Error("pi-tui SelectList internals changed; it now needs a public setItems() (see docs/pi-api-notes.md)");
	}
	internal.items = items;
	internal.filteredItems = [...items];
}

/**
 * Show the dialer setup screen. Returns the edited rows, or null on cancel.
 */
export async function selectDialerSetup(
	ctx: ExtensionContext,
	available: Model<Api>[],
	initial: SetupRow[],
): Promise<SetupRow[] | null> {
	if (!ctx.hasUI) return null;

	const models = toModelInfo(available);
	const rows: SetupRow[] = initial.map((r) => ({ ...r }));

	return ctx.ui.custom<SetupRow[] | null>((tui, theme, _kb, done) => {
		let mode: "tasks" | "picker" = "tasks";
		let taskIndex = 0;
		let searching = false;
		let query = "";
		// Reuse Input purely as a robust text buffer (handles legacy + Kitty key protocols).
		const searchBuffer = new Input();

		const accent = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);

		const container = new Container();
		container.addChild(new DynamicBorder((s) => accent(s)));
		container.addChild(new Text(accent(theme.bold("Dialer Setup"))));
		container.addChild(new Text(dim("Pick a model and thinking level per task type. Saved to the global dialer.json.")));
		container.addChild(new Spacer(1));

		const taskTexts = rows.map(() => new Text(""));
		for (const t of taskTexts) container.addChild(t);
		container.addChild(new Spacer(1));

		const pickerHeader = new Text("");
		const searchLine = new Text("");
		container.addChild(pickerHeader);
		container.addChild(searchLine);

		// Columns: provider (left) · model name (right).
		const providerWidth = Math.min(16, Math.max(8, ...models.map((m) => m.provider.length)) + 2);
		const makeItems = (filtered: ModelInfo[]): SelectItem[] => [
			{ value: KEEP_CURRENT, label: "(keep current model)", description: "route only sets thinking" },
			...filtered.map((m) => ({
				value: m.identifier,
				label: `${m.provider.padEnd(providerWidth)}${m.name}`,
				description: "",
			})),
		];

		const selectList = new SelectList(
			makeItems(models),
			Math.min(Math.max(models.length + 1, 1), 10),
			getSelectListTheme(),
			{ minPrimaryColumnWidth: providerWidth + 18, maxPrimaryColumnWidth: providerWidth + 40 },
		);
		container.addChild(selectList);

		const hint = new Text("");
		container.addChild(hint);
		container.addChild(new DynamicBorder((s) => accent(s)));

		const taskWidth = Math.max(...rows.map((r) => r.task.length)) + 2;

		function taskRowText(i: number): string {
			const row = rows[i];
			const focused = mode === "tasks" && i === taskIndex;
			const cursor = focused ? accent("› ") : "  ";
			const task = focused ? accent(row.task.padEnd(taskWidth)) : dim(row.task.padEnd(taskWidth));
			const model = rowModelLabel(row.model);
			const thinking = ` · thinking: ${thinkingLabel(row.thinking)}`;
			return `${cursor}${task}${focused ? theme.bold(model) : model}${dim(thinking)}`;
		}

		function currentHint(): string {
			if (mode === "picker") {
				return searching
					? dim("type to filter • ↑/↓ move • Enter pick • Esc done")
					: dim(`model for ${rows[taskIndex].task} — ↑/↓ move • Enter pick • / search • Esc back`);
			}
			return dim("↑/↓ task • Enter choose model • ←/→ or t thinking • s save • Esc cancel");
		}

		function refresh() {
			taskTexts.forEach((t, i) => t.setText(taskRowText(i)));
			if (mode === "picker") {
				const prev = selectList.getSelectedItem()?.value;
				const items = makeItems(filterModels(models, query));
				setSelectListItems(selectList, items);
				const idx = prev ? items.findIndex((i) => i.value === prev) : 0;
				selectList.setSelectedIndex(idx >= 0 ? idx : 0);
				pickerHeader.setText(accent(`▸ Model for ${rows[taskIndex].task}`));
				searchLine.setText(
					searching
						? dim("  search: ") + query + accent("▏")
						: query
							? dim(`  filter: ${query}  (/ to edit)`)
							: dim("  / to search"),
				);
			} else {
				pickerHeader.setText("");
				searchLine.setText("");
				setSelectListItems(selectList, []);
			}
			hint.setText(currentHint());
			selectList.invalidate();
			tui.requestRender();
		}

		function pickModel() {
			const item = selectList.getSelectedItem();
			if (!item) return;
			rows[taskIndex].model = item.value === KEEP_CURRENT ? undefined : item.value;
			mode = "tasks";
			searching = false;
			query = "";
			refresh();
		}

		refresh();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (mode === "picker") {
					if (searching) {
						if (matchesKey(data, Key.escape)) {
							searching = false;
							refresh();
							return;
						}
						if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
							pickModel();
							return;
						}
						if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
							selectList.handleInput(data);
							return;
						}
						// Forward editing/printable keys to the Input buffer (robust across key protocols).
						const before = searchBuffer.getValue();
						searchBuffer.handleInput(data);
						const after = searchBuffer.getValue();
						if (after !== before) {
							query = after;
							refresh();
						}
						return;
					}
					if (matchesKey(data, Key.escape)) {
						mode = "tasks";
						query = "";
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
						pickModel();
						return;
					}
					if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
						selectList.handleInput(data);
						return;
					}
					if (data === "/") {
						searching = true;
						refresh();
					}
					return;
				}

				// Tasks mode.
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (matchesKey(data, Key.up)) {
					taskIndex = (taskIndex - 1 + rows.length) % rows.length;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					taskIndex = (taskIndex + 1) % rows.length;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
					mode = "picker";
					searching = false;
					query = "";
					searchBuffer.setValue("");
					refresh();
					return;
				}
				if (matchesKey(data, Key.right) || data === "t") {
					rows[taskIndex].thinking = cycleThinking(rows[taskIndex].thinking, 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.left)) {
					rows[taskIndex].thinking = cycleThinking(rows[taskIndex].thinking, -1);
					refresh();
					return;
				}
				if (data === "s") {
					done(rows.map((r) => ({ ...r })));
					return;
				}
			},
		};
	});
}
