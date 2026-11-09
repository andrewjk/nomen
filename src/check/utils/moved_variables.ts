import type CheckStatus from "../CheckStatus.ts";

/**
 * The moved names in `scoped_status` whose innermost declaration predates
 * `scope_base` (the enclosing scope's `values` length when the clone was
 * taken) — i.e. names that refer to a variable visible OUTSIDE the cloned
 * region. `moved_variables` is keyed by name, not by declaration, so a
 * body-local declaration that shadows (or merely reuses) an enclosing name
 * would otherwise leak its move past the declaration's own scope and move
 * the enclosing scope's unrelated variable.
 */
export function outer_scope_moved(
	scoped: CheckStatus,
	scope_base: number,
): Set<string> | undefined {
	if (!scoped.moved_variables?.size) return undefined;
	let filtered: Set<string> | undefined;
	for (const name of scoped.moved_variables) {
		const idx = scoped.values.findLastIndex((v) => v.name === name);
		if (idx >= 0 && idx < scope_base) {
			filtered ??= new Set();
			filtered.add(name);
		}
	}
	return filtered;
}

/**
 * Branch-local move reconciliation: the arm clones start from the parent's
 * moved set, so at merge a name stays moved only when EVERY contributing
 * (fall-through) arm ends with it moved — both-moved ⇒ moved. A move on one
 * path only stays branch-local (the conservative posture: single-path facts
 * never reject), and a re-initialization on every path un-moves in the
 * parent (the assignment deleted the name from each arm's set). An
 * `undefined` set is the lazily-empty set; an empty intersection collapses
 * back to `undefined`.
 */
export function intersect_moved_variables(
	sets: Array<Set<string> | undefined>,
): Set<string> | undefined {
	let merged: Set<string> | undefined;
	for (const set of sets) {
		if (merged === undefined) {
			merged = set ? new Set(set) : new Set();
			continue;
		}
		if (!set) {
			return undefined;
		}
		for (const name of merged) {
			if (!set.has(name)) merged.delete(name);
		}
	}
	return merged && merged.size > 0 ? merged : undefined;
}

/**
 * Loop-body move reconciliation: the body may run before the post-loop
 * code, so any name still moved at the body's end joins the enclosing
 * scope's moved set — a use after the loop is rejected unless the body
 * re-initializes the name on the iterations that run. A body-local
 * re-initialization cannot un-move a name the parent had moved (zero
 * iterations leave it moved), so this is a one-way union, never a copy-back.
 */
export function persist_moved_variables(status: CheckStatus, moved: Set<string> | undefined): void {
	if (!moved?.size) return;
	if (!status.moved_variables) status.moved_variables = new Set();
	for (const name of moved) status.moved_variables.add(name);
}
