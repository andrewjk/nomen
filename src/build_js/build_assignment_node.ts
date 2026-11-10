import type AssignmentNode from "../nodes/AssignmentNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { emit, expr, next_temp } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { js_name } from "./names.ts";

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
	write_back_ref_param(node, status);
}

/** A `ref` parameter is a local bound from its box: after every assignment
 *  the box receives the new value (the caller copies it out at the call). */
function write_back_ref_param(node: AssignmentNode, status: BuildStatus): void {
	if (node.left_value.node_type !== "value") return;
	const name = js_name((node.left_value as ValueNode).value);
	if (!status.ref_params?.has(name)) return;
	emit(status, `__ref_${name}.v = ${name};`);
}
