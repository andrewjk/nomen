import type AssignmentNode from "../nodes/AssignmentNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { emit, expr, next_temp } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { js_name } from "./names.ts";
import { copy_if_value_struct, stamped_type, wrap_for_type, wrap_int_expression } from "./types.ts";

/** Emit an assignment (plain, compound, or `x = y swap z`). */
export default function build_assignment_node(node: AssignmentNode, status: BuildStatus): void {
	const left = expr(node.left_value, status);
	const raw_right = expr(node.right_value, status);
	// Value-struct assignment copies (the displaced binding must stay
	// independent). `mv` transfers keep the reference.
	const right = copy_if_value_struct(raw_right, stamped_type(node.right_value)?.name, status);

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

	const operator = node.operator ?? "=";
	if (operator !== "=" && operator.endsWith("=")) {
		// Compound assignment: the arithmetic wraps at the target's width.
		const base_op = operator.slice(0, -1);
		const target = stamped_type(node.left_value)?.name;
		const combined = wrap_int_expression(`(${left} ${base_op} ${right})`, target);
		emit(status, `${left} = ${combined};`);
	} else {
		emit(status, `${left} = ${wrap_for_type(right, stamped_type(node.left_value))};`);
	}
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
