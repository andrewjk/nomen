import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import Type from "../nodes/Type.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { persist_invalidated } from "./utils/borrow.ts";
import clone_status from "./utils/clone_status.ts";

/**
 * Check an `async { ... }` nursery block.
 *
 * If the block names its nursery (`async nursery { }` or
 * `async pool = Nursery(opts) { }`), a `Nursery`-typed variable of that name is
 * declared in the block's scope — it is the capability passed to functions that
 * spawn into this nursery and the receiver of `name.spawn(fn(args))`.
 *
 * If a timeout expression is present, it is type-checked (must resolve to an
 * integer type).
 */
export default function check_async_block_node(node: AsyncBlockNode, status: CheckStatus) {
	const block_status = clone_status(status);
	if (node.nursery_name) {
		block_status.values.push({
			// The nursery is a mutable capability: tasks are spawned into it
			// (pool.spawn) and it is borrowed (ref pool) by functions that
			// spawn on the caller's behalf, so it must be a `var`, not `const`.
			declaration: "var",
			name: node.nursery_name,
			type: new Type("Nursery"),
			is_set: true,
			start: node.start,
			decl_depth: block_status.scope_depth + 1,
		});
	}
	if (node.timeout) {
		check_node(node.timeout, block_status);
	}
	check_block_node(node, block_status);
	persist_invalidated(status, block_status);
}
