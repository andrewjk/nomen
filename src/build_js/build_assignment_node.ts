import type AssignmentNode from "../nodes/AssignmentNode.ts";
import { emit, expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Emit an assignment (plain or compound) as a JS statement. */
export default function build_assignment_node(node: AssignmentNode, status: BuildStatus): void {
	const left = expr(node.left_value, status);
	const right = expr(node.right_value, status);
	emit(status, `${left} ${node.operator ?? "="} ${right};`);
}
