import collect_allocations from "../../build_common/collect_allocations.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import build_node from "../build_node.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Recursively collects all allocation declarations attached to a node and its
 * children and builds them as separate C statements. The walk is shared with
 * the aarch64 backend (`build_common/collect_allocations.ts`); the C arm
 * turns `let_values` ON — a LetNode's value allocations (e.g. interpolation
 * temporaries in a match/if/switch-expression branch) must surface BEFORE
 * the let emits its `<target> = ` prefix under `status.return_assign`,
 * otherwise the hoisted declaration lands mid-expression (invalid C).
 *
 * This solves the problem of function-call argument temporaries ending up
 * inside expressions (if/while conditions, assignment RHS, etc.), which would
 * be invalid C.
 *
 * Deliberately does NOT clear `node.allocations` — the AST may be built more
 * than once (e.g. the C and aarch64 backends on one parse), and clearing
 * would starve any later build of its allocations. Duplicate emission within
 * a single build is prevented by `status.emitted_allocations`, which
 * build_node's inline emission path also checks.
 */
export default function emit_allocations(node: BaseNode, status: BuildStatus) {
	if (!status.emitted_allocations) status.emitted_allocations = new Set();
	const allocations = collect_allocations(node, { let_values: true });
	for (const alloc of allocations) {
		if (status.emitted_allocations.has(alloc)) continue;
		status.emitted_allocations.add(alloc);
		build_node(alloc, status, true);
	}
}
