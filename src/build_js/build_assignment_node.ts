import type AssignmentNode from "../nodes/AssignmentNode.ts";
import { emit, expr, next_temp } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Emit an assignment (plain, compound, or `x = y swap z`). */
export default function build_assignment_node(node: AssignmentNode, status: BuildStatus): void {
	const left = expr(node.left_value, status);
	const right = expr(node.right_value, status);

	// `a = b swap c`: `a` takes `b`'s value, then `b` is revalidated with
	// `c`. The RHS is read once into a temp (the sides may alias).
	if (node.swap) {
		const temp = next_temp(status, "swap");
		emit(status, "{");
		status.indent += 1;
		emit(status, `const ${temp} = ${right};`);
		emit(status, `${left} = ${temp};`);
		emit(status, `${right} = ${expr(node.swap, status)};`);
		status.indent -= 1;
		emit(status, "}");
		return;
	}

	emit(status, `${left} ${node.operator ?? "="} ${right};`);
}
