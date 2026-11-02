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
 * Dependencies are emitted FIRST: an allocation's own initializer may
 * reference hoisted temps nested in its value (a receiver temp
 * `_recv_N = m.get_or(k, make(x))` whose argument `make(x)` is a hoisted
 * `_param_N`). Emitting the receiver first put the argument's declaration
 * inside the receiver's initializer (`struct Rec _recv_1 = unsigned char
 * _mv_owns__param_0 = 0; ...` — invalid C). The nested value allocations are
 * emitted before their host, recursively.
 *
 * Deliberately does NOT clear `node.allocations` — the AST may be built more
 * than once (e.g. the C and aarch64 backends on one parse), and clearing
 * would starve any later build of its allocations. Duplicate emission within
 * a single build is prevented by `status.emitted_allocations`, which
 * build_node's inline emission path also checks.
 */
export default function emit_allocations(node: BaseNode, status: BuildStatus) {
	if (!status.emitted_allocations) status.emitted_allocations = new Set();
	const emitted = status.emitted_allocations;
	// Cycle guard for the dependency walk (an allocation's value subtree
	// cannot contain the allocation itself, but the AST is shared and a
	// pathological self-reference must not hang the build).
	const in_progress = new Set<BaseNode>();
	const emit_one = (alloc: BaseNode): void => {
		if (emitted.has(alloc) || in_progress.has(alloc)) return;
		in_progress.add(alloc);
		// Surface this allocation's nested value temps first (see header).
		for (const nested of collect_allocations(alloc, { let_values: true })) {
			emit_one(nested);
		}
		in_progress.delete(alloc);
		if (emitted.has(alloc)) return;
		emitted.add(alloc);
		build_node(alloc, status, true);
	};
	for (const alloc of collect_allocations(node, { let_values: true })) {
		emit_one(alloc);
	}
}
