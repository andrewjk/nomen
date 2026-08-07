import type BuildStatus from "../build_c/BuildStatus.ts";
import { emit_cleanup_to_loop_depth } from "./utils/auto_destroy.ts";

export default function build_break_node(status: BuildStatus) {
	const loop = status.loop_labels?.[status.loop_labels.length - 1];
	if (loop) {
		emit_cleanup_to_loop_depth(status);
		// Persist any mutated `for ref x` loop variable before exiting.
		status.loop_writebacks?.[status.loop_writebacks.length - 1]?.();
		status.code += `b ${loop.end}\n`;
	}
}
