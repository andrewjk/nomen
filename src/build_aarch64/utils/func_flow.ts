import type BaseNode from "../../nodes/BaseNode.ts";
import type BranchNode from "../../nodes/BranchNode.ts";
import type ForLoopNode from "../../nodes/ForLoopNode.ts";
import type IfElseNode from "../../nodes/IfElseNode.ts";
import type MatchNode from "../../nodes/MatchNode.ts";
import type SwitchNode from "../../nodes/SwitchNode.ts";
import type WhileLoopNode from "../../nodes/WhileLoopNode.ts";

/**
 * Flow-aware variable-reference collection for whole-function register
 * allocation (ASM_PLAN phase 4 — liveness groundwork tranche).
 *
 * Replaces the per-statement `collect_var_refs` walks in
 * `plan_function_promotions` with ONE walk over the body that:
 *
 * 1. Sees every control region. The previous scanner missed identifiers
 *    inside if branches (IfElseNode stores `if_branch`/`else_branch`, not
 *    `statements`/`else_statements`), method-call arguments
 *    (AccessFunctionCallNode carries `params`, not `args`), switch/match arms
 *    (whose `{condition, branch}` wrappers are plain objects without a
 *    `node_type` tag), nested blocks and swap-parameter expressions. Missing
 *    reads under-promoted; missing address-takes were a soundness hole in the
 *    promotion exclusions.
 * 2. Weights each read by its LOOP NESTING DEPTH: a read inside d enclosing
 *    loops executes ~trip-count more often than a top-level read, so it
 *    ranks hotter for a scarce callee-saved register. Depth comes straight
 *    from the structured AST (no goto exists), so structural nesting equals
 *    dynamic nesting; this is the flow fact a CFG/dominator pass over a
 *    future canonical IR will subsume.
 *
 * Results feed eligibility (raw reads vs MIN_READS, address_taken) exactly as
 * before — ranking stays raw-frequency first, with weighted reads breaking
 * ties between equal counts, so functions whose hotness raw counts couldn't
 * see resolve deterministically toward the loop-hot variable.
 */

export interface FlowRefInfo {
	/** Unweighted identifier-read count (same semantics as collect_var_refs). */
	reads: number;
	/** Reads weighted by enclosing-loop nesting (`reads * HOTNESS ** depth`). */
	weighted_reads: number;
	address_taken: boolean;
}

/** Register-priority multiplier per enclosing loop level. */
const HOTNESS_PER_LEVEL = 8;
/** Nesting levels beyond which reads stop earning additional priority. */
const MAX_DEPTH = 4;

function hotness(depth: number): number {
	const capped = Math.min(depth, MAX_DEPTH);
	let w = 1;
	for (let i = 0; i < capped; i++) w *= HOTNESS_PER_LEVEL;
	return w;
}

function is_identifier(val: unknown): val is string {
	return (
		typeof val === "string" &&
		val.length > 0 &&
		!/^(\+|-)?\d+(\.\d+)?$/.test(val) &&
		!val.startsWith('"') &&
		!val.startsWith("'") &&
		val !== "true" &&
		val !== "false" &&
		val !== "null" &&
		val !== "self" &&
		val !== "as"
	);
}

/** Keys whose subtrees belong to ANOTHER function body or to plumbing. */
const SKIP_KEYS = new Set(["parent", "scope", "resolved_function"]);

/**
 * Collect raw + loop-depth-weighted reads (and address-take marks) for every
 * variable referenced anywhere in the function body. Returns a fresh map;
 * names never promoted against (literals, keywords, field sub-expressions
 * reached non-address contexts) may appear but are ignored by callers.
 */
export default function collect_weighted_var_refs(func: {
	statements: BaseNode[];
}): Map<string, FlowRefInfo> {
	const info = new Map<string, FlowRefInfo>();

	function get(name: string): FlowRefInfo {
		let entry = info.get(name);
		if (!entry) {
			entry = { reads: 0, weighted_reads: 0, address_taken: false };
			info.set(name, entry);
		}
		return entry;
	}

	function count(name: string, depth: number) {
		const entry = get(name);
		entry.reads++;
		entry.weighted_reads += hotness(depth);
	}

	function visit(n: BaseNode | null | undefined, depth: number, in_access_target = false): void {
		if (!n || typeof n !== "object") return;

		// Case-arm wrappers ({condition, branch}) and similar structural bags
		// carry no node_type — descend through their members unchanged.
		if (!(n as any).node_type) {
			descend(n, depth);
			return;
		}

		switch (n.node_type) {
			case "value": {
				const val = (n as any).value;
				if (is_identifier(val)) {
					count(val, depth);
					if (in_access_target) get(val).address_taken = true;
				}
				return;
			}
			case "op": {
				const op = n as any;
				visit(op.left_value, depth);
				visit(op.right_value, depth);
				return;
			}
			case "grouped":
			case "cast":
			case "let":
			case "declare": {
				visit((n as any).value, depth);
				return;
			}
			case "assign": {
				const asgn = n as any;
				visit(asgn.left_value, depth);
				visit(asgn.right_value, depth);
				return;
			}
			case "access": {
				const acc = n as any;
				// The receiver expression yields its ADDRESS for member access
				// (the backend materializes &slot / data pointers from it).
				visit(acc.target, depth, true);
				visit(acc.access, depth);
				return;
			}
			case "access_func": {
				const call = n as any;
				for (const p of call.params || []) visit(p, depth);
				if (call.swap_params instanceof Map) {
					for (const swapee of call.swap_params.values()) {
						visit(swapee, depth, true);
					}
				}
				return;
			}
			case "func_call": {
				const fc = n as any;
				for (const p of fc.params || []) visit(p, depth);
				return;
			}
			case "return": {
				visit((n as any).value, depth);
				return;
			}
			case "range": {
				const range = n as any;
				visit(range.left_value, depth);
				visit(range.right_value, depth);
				return;
			}
			case "array": {
				for (const v of (n as any).values || []) visit(v, depth);
				return;
			}
			case "if": {
				const iff = n as IfElseNode;
				visit(iff.condition, depth);
				visit_branch(iff.if_branch, depth);
				visit_branch(iff.else_branch, depth);
				return;
			}
			case "switch": {
				const sw = n as SwitchNode;
				for (const c of sw.cases || []) {
					visit(c.condition, depth);
					visit_branch(c.branch, depth);
				}
				visit_branch(sw.else_branch, depth);
				return;
			}
			case "match": {
				const m = n as MatchNode;
				visit(m.value, depth);
				for (const c of m.cases || []) {
					visit(c.match_value, depth);
					visit_branch(c.branch, depth);
				}
				visit_branch(m.else_branch, depth);
				return;
			}
			case "branch": {
				visit_branch(n as BranchNode, depth);
				return;
			}
			case "while": {
				const wh = n as WhileLoopNode;
				visit(wh.condition, depth + 1);
				for (const s of wh.statements) visit(s, depth + 1);
				if (wh.update) visit(wh.update, depth + 1);
				return;
			}
			case "for": {
				const f = n as ForLoopNode;
				// The iterated list is evaluated once; per-iteration traffic
				// (the item, the body, the update hook) runs at depth + 1.
				visit(f.list, depth);
				if ((f as any).index) visit((f as any).index, depth);
				visit(f.item, depth + 1);
				for (const s of f.statements) visit(s, depth + 1);
				if (f.update) visit(f.update, depth + 1);
				return;
			}
			default: {
				descend(n, depth);
				return;
			}
		}

		function visit_branch(branch: BranchNode | undefined | null, d: number) {
			if (!branch) return;
			for (const s of branch.statements) visit(s, d);
		}
	}

	/** Structural-bag traversal: recurse through every member subtree. */
	function descend(container: object, depth: number): void {
		for (const key of Object.keys(container)) {
			if (SKIP_KEYS.has(key)) continue;
			const val = (container as any)[key];
			if (!val || typeof val !== "object") continue;
			if (val instanceof Map) {
				for (const v of val.values()) {
					if (v && typeof v === "object") visit(v, depth);
				}
				continue;
			}
			if (Array.isArray(val)) {
				for (const item of val) {
					if (item && typeof item === "object") visit(item, depth);
				}
				continue;
			}
			visit(val, depth);
		}
	}

	for (const stmt of func.statements) visit(stmt, 0);
	return info;
}
