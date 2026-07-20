import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import check_block_node from "./check_block_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { persist_invalidated } from "./utils/borrow.ts";
import clone_status from "./utils/clone_status.ts";

/**
 * Check an `async { ... }` nursery block. For v1 this is the same as a
 * regular block — the nursery invariants are enforced at build time
 * (implicit join at scope exit).
 */
export default function check_async_block_node(node: AsyncBlockNode, status: CheckStatus) {
	const block_status = clone_status(status);
	check_block_node(node, block_status);
	persist_invalidated(status, block_status);
}
