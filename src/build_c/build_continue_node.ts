import ContinueNode from "../nodes/ContinueNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import { reclaim_to_loop_body } from "./utils/c_scope.ts";

export default function build_continue_node(node: ContinueNode, status: BuildStatus) {
	// Reclaim declarations from the current scope up through the innermost
	// loop's body frame before jumping — `continue` skips the loop body's
	// scope-exit auto_free, so those declarations would otherwise leak each
	// iteration. Mirrors aarch64's emit_cleanup_to_loop_depth.
	reclaim_to_loop_body(status);
	// Persist any mutated `for ref x` loop variable before continuing.
	status.loop_writebacks?.[status.loop_writebacks.length - 1]?.();
	status.code += `continue;\n`;
}
