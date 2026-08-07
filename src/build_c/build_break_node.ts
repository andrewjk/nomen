import BreakNode from "../nodes/BreakNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import { reclaim_to_loop_body } from "./utils/c_scope.ts";

export default function build_break_node(node: BreakNode, status: BuildStatus) {
	// Reclaim declarations from the current scope up through the innermost
	// loop's body frame before jumping. Without this, `break` leaks every
	// declaration in the scopes it exits (their scope-exit auto_free is dead
	// code after the jump). Mirrors aarch64's emit_cleanup_to_loop_depth.
	reclaim_to_loop_body(status);
	// Persist any mutated `for ref x` loop variable before exiting.
	status.loop_writebacks?.[status.loop_writebacks.length - 1]?.();
	status.code += `break;\n`;
}
