import type { NirStmt } from "../nir/nir.ts";
import NestedBlockNode from "../nodes/NestedBlockNode.ts";
import build_auto_free from "./build_auto_free.ts";
import type BuildStatus from "./BuildStatus.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";

/**
 * A bare nested block statement (`{ ... }`): a plain lexical scope. The
 * block's declarations die — and their scope-exit frees run — at the closing
 * brace, mirroring the per-arm scoping the if/while builders establish.
 */
export default function build_nested_block_node(
	node: NestedBlockNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "block" },
) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];

	status.code += `{\n`;
	build_block_with_cursor(node, nir?.body, status);
	// Scope-exit auto-free: every declaration the block made is reclaimed at
	// the closing brace.
	build_auto_free(status);
	status.code += `}\n`;

	leave_c_scope(status);
	status.deferred_frees = old_deferred_frees;
	status.scoped_declarations = old_scoped_declarations;
}
