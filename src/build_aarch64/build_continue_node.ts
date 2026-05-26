import type BuildStatus from "../build/BuildStatus.ts";
import { emit_cleanup_to_loop_depth } from "./utils/auto_destroy.ts";

export default function build_continue_node(status: BuildStatus) {
	const loop = status.loop_labels?.[status.loop_labels.length - 1];
	if (loop) {
		emit_cleanup_to_loop_depth(status);
		status.code += `b ${loop.start}\n`;
	}
}
