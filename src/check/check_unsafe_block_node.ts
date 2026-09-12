import UnsafeBlockNode from "../nodes/UnsafeBlockNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";

/**
 * `unsafe { ... }` — a scoped region in which pointer operations are legal.
 * Statements are checked in order with `in_unsafe` raised; the flag is
 * restored afterwards so an unsafe block never leaks past its braces.
 */
export default function check_unsafe_block_node(node: UnsafeBlockNode, status: CheckStatus) {
	const was_unsafe = status.in_unsafe;
	status.in_unsafe = true;
	status.stack.push(node);
	for (const child of node.statements) {
		check_node(child, status);
	}
	status.stack.pop();
	status.in_unsafe = was_unsafe;
	return true;
}
