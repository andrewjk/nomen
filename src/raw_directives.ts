import type BaseNode from "./nodes/BaseNode.ts";
import type FunctionNode from "./nodes/FunctionNode.ts";
import type RawNode from "./nodes/RawNode.ts";

/**
 * Raw-block classification helpers.
 *
 * The block's own nature lives on the `RawNode` (`is_c` for companion-C,
 * `scope` for file scope) — spelled on the opener, `#raw("c", "file")`. Target
 * selection is the `#if META.arch` fold (docs/COMPTIME.md stage 5), so
 * every raw node reaching these helpers already belongs to the current target.
 */

/** Whether a raw node is companion-compiled C source (`#raw("c")`). */
export function raw_node_is_companion_c(node: BaseNode): boolean {
	return !!(node as RawNode).is_c;
}

/**
 * A body that MIXES `#raw("c")` (companion-C) blocks with code the aarch64
 * backend would silently drop. The backend routes such a function WHOLE to
 * the C companion — the concatenation of its `#c` blocks (check_c_fallback)
 * — so Nomen statements around them (and unmarked blocks, which would emit
 * inline asm on aarch64) compile on the C backend but never run on aarch64:
 * the same source would mean different things per backend.
 */
export interface UseCMixedBody {
	/** What the aarch64 backend would drop: a Nomen statement, an unmarked
	 *  raw block (inline assembly), or a `#c` block NESTED inside control
	 *  flow (the body is asm-emitted and block-scope C has no inline splice
	 *  — the block never reaches the companion). */
	dropped: "statement" | "raw asm" | "nested block";
	/** Position of the first dropped node (the error location). */
	start: number;
}

export function find_use_c_mixed_body(func: FunctionNode): UseCMixedBody | null {
	let has_use_c = false;
	const drops: UseCMixedBody[] = [];
	for (const stmt of func.statements) {
		if (stmt.node_type !== "raw") {
			drops.push({ dropped: "statement", start: stmt.start });
			continue;
		}
		if ((stmt as RawNode).is_c) {
			has_use_c = true;
			continue;
		}
		// An unmarked block emits inline assembly on aarch64 — dropped when
		// the body goes to the companion.
		drops.push({ dropped: "raw asm", start: stmt.start });
	}
	if (!has_use_c) {
		// No whole-body replacement is in play — but a `#c` block can still
		// sit NESTED inside control flow. There the aarch64 backend emits
		// the body as assembly and block-scope C has no inline splice: the
		// block never reaches the companion (found the hard way building
		// Window.run's resize stamping — see the build-side backstop in
		// build_raw_node).
		return find_nested_use_c_block(func.statements);
	}
	return drops[0] ?? null;
}

/**
 * Descend into nested control-flow statements and report the first
 * block-scope `#c` raw block. Nested functions are boundaries — their
 * bodies get their own check pass (their own find_use_c_mixed_body run).
 * File-scope blocks (`#raw(…, "file")`) are exempt: file-scope C hoists to
 * the companion's file scope and emits wherever the carrier function sits
 * (the blessed pattern for delegate IMPs and registries).
 */
function find_nested_use_c_block(statements: BaseNode[]): UseCMixedBody | null {
	let found: UseCMixedBody | null = null;
	const visit = (value: unknown): void => {
		if (found || !value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const n = value as BaseNode;
		if (typeof n.node_type !== "string") return;
		// Nested functions are checked on their own pass.
		if (n.node_type === "func" || n.node_type === "struct" || n.node_type === "trait") return;
		if (n.node_type === "raw") {
			const raw = n as RawNode;
			if (raw.is_c && raw.scope !== "file") {
				found = { dropped: "nested block", start: n.start };
			}
			return;
		}
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (key === "parent" || key === "scope" || key === "node_type") continue;
			visit(record[key]);
		}
	};
	for (const stmt of statements) visit(stmt);
	return found;
}
