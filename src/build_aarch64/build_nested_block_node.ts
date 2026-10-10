import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import NestedBlockNode from "../nodes/NestedBlockNode.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";

/**
 * A bare nested block statement (`{ ... }`): a plain lexical scope. The
 * frame swap keeps the block's declarations out of the enclosing scope's
 * cleanup, and the block walk's own `emit_destroy_for_scope` reclaims them
 * at the closing brace.
 */
export default function build_nested_block_node(
	node: NestedBlockNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "block" },
) {
	const frame = enter_scope_frame(status);
	build_block_with_cursor(node, nir?.body, status);
	exit_scope_frame(status, frame);
}
