import type BuildStatus from "../../build_c/BuildStatus.ts";
import collect_allocations from "../../build_common/collect_allocations.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import { forwardable_hoisted_param } from "../access_staging.ts";
import build_node from "../build_node.ts";

/**
 * Recursively collects all allocation declarations attached to a node and its
 * children, builds them as separate aarch64 statements. The walk is shared
 * with the C backend (`build_common/collect_allocations.ts`) — the aarch64
 * arm leaves `let_values` off (no LetNode ever materializes as a statement
 * here).
 *
 * Unlike the original per-backend copies this deliberately does NOT clear
 * `node.allocations`: the AST is shared between the aarch64 and C builds
 * (the test harness parses once and builds twice), so mutating it here
 * would starve the second build of its allocations. Duplicate emission
 * within a single aarch64 build is prevented by removing the inline
 * `if (node.allocations)` emission from `build_node` — this
 * `emit_allocations` (called per statement from `build_block_node`) is the
 * sole source.
 */
export default function emit_allocations(node: BaseNode, status: BuildStatus) {
	if (!status.emitted_allocations) status.emitted_allocations = new Set();
	const allocations = collect_allocations(node);
	// Access-staging forwarding (ASM_PLAN_3 tranche L): a `_param_N` hoisted
	// temp with a pure scalar initializer is not emitted at all — the
	// accessor paths re-build its tree at the single read, so the index sum
	// never round-trips a frame slot. The map is ALWAYS reset here so a
	// stale entry can never outlive its statement (build_block_node
	// restores the enclosing statement's map afterwards).
	const forwarded = new Map<string, BaseNode>();
	if (allocations.length) {
		for (const alloc of allocations) {
			const tree = forwardable_hoisted_param(alloc, node);
			if (tree) forwarded.set((alloc as DeclarationNode).name, tree);
		}
	}
	// Tranche M: value-numbered `_param_N` inits — the temp's chain had its
	// invariant prefix hoisted to a preheader `_vn_N` declare, so the temp
	// must not emit at all; the accessor's staging path re-builds the
	// rewritten tree at the read. These entries win over the L gating
	// (their soundness gates ran in the pass).
	const vn_inits = status.vn_param_inits?.get(node);
	if (process.env.VN_SPLICE_DBG && node.start > 87900 && node.start < 89400) {
		console.error(
			`EA node=${node.start} allocs=${allocations.length} vn=${vn_inits ? [...vn_inits.keys()].join(",") : "none"} fwd=[${[...forwarded.keys()].join(",")}]`,
		);
	}
	if (vn_inits) {
		for (const [name, tree] of vn_inits) forwarded.set(name, tree);
	}
	status.forwarded_param_inits = forwarded;
	for (const alloc of allocations) {
		if (status.emitted_allocations.has(alloc)) continue;
		status.emitted_allocations.add(alloc);
		if (forwarded.has((alloc as DeclarationNode).name)) continue;
		build_node(alloc, status, true);
	}
}
