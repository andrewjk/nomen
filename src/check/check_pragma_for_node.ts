import BaseNode from "../nodes/BaseNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import NestedBlockNode from "../nodes/NestedBlockNode.ts";
import type PragmaForNode from "../nodes/PragmaForNode.ts";
import type CheckStatus from "./CheckStatus.ts";
import { expand_pragma_for } from "./utils/comptime.ts";

/**
 * Check a compile-time `#for` (stage 2, docs/COMPTIME_PLAN_2.md). The
 * expansion happens HERE — before the arm's statements are ever checked —
 * and the per-field iteration blocks are spliced into the statement list
 * directly AFTER the pragma node, so the enclosing walk (a live for..of
 * over `statements`) checks them in order as ordinary blocks. The pragma
 * node itself stays in the list as a consumed placeholder until NIR; the
 * backends never see a non-deferred one.
 *
 * Deferred loops (R3 — T is an unbound type parameter) leave the node
 * untouched: the generic body is skipped here and the specialization's
 * re-check reaches the cloned node with the parameter bound.
 */
export default function check_pragma_for_node(node: PragmaForNode, status: CheckStatus): void {
	const iterations = expand_pragma_for(node, status);
	if (iterations === null) return; // deferred
	const parent = status.stack.at(-1) as BlockNode | undefined;
	if (!parent || !Array.isArray(parent.statements)) {
		// Only reachable from statement lists (the parser attaches the node
		// nowhere else); a missing parent means an internal misuse.
		return;
	}
	const index = parent.statements.indexOf(node);
	if (index === -1) return;
	// FILE scope (declaration generation, stage 6): the iterations splice
	// FLAT — the generated structs/functions become root statements, exactly
	// like hand-written declarations. The per-iteration wrapper block is the
	// R8 hygiene for BODY scopes (iteration locals cannot collide) — at file
	// scope there are no locals to collide, and a wrapper would nest the
	// generated types inside a runtime block the backends would have to
	// hoist back out.
	const flat = parent.node_type === "root";
	const spliced: BaseNode[] = [];
	for (const iteration of iterations) {
		if (flat && iteration.node_type === "block") {
			spliced.push(...((iteration as NestedBlockNode).statements ?? []));
		} else {
			spliced.push(iteration);
		}
	}
	parent.statements.splice(index + 1, 0, ...spliced);
}
