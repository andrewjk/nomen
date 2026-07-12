import OperationNode from "../nodes/OperationNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { is_nullable_struct_type } from "./utils/nullable_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_operation_node(node: OperationNode, status: BuildStatus) {
	if (node.op === "!") {
		status.code += `!`;
		build_node(node.right_value, status);
	} else if (node.op === "??") {
		// `nullable ?? fallback`. For a nullable struct, the flag is `<expr>_has`.
		const left_type = type_from_value_node(node.left_value);
		if (is_nullable_struct_type(left_type, status)) {
			status.code += `(`;
			status.code += build_nullable_has(node.left_value, status);
			status.code += ` ? `;
			build_node(node.left_value, status);
			status.code += ` : `;
			build_node(node.right_value, status);
			status.code += `)`;
		} else {
			status.code += `(`;
			build_node(node.left_value, status);
			status.code += ` ? `;
			build_node(node.left_value, status);
			status.code += ` : `;
			build_node(node.right_value, status);
			status.code += `)`;
		}
	} else if ((node.op === "==" || node.op === "!=") && is_null_comparison(node)) {
		// `x == null` / `x != null` against a nullable struct lowers to its
		// companion `_has` flag rather than comparing the struct value to 0.
		const nullable_side = is_nullable_struct_side(node.left_value, status)
			? node.left_value
			: node.right_value;
		const type = type_from_value_node(nullable_side);
		if (is_nullable_struct_type(type, status)) {
			const has = build_nullable_has(nullable_side, status);
			// `== null` → !has ; `!= null` → has
			status.code += node.op === "==" ? `(!${has})` : `(${has})`;
		} else {
			build_default_binary(node, status);
		}
	} else if (node.operator_func) {
		// Custom operator function call
		const label =
			node.operator_func.mangled_name ||
			`${node.operator_func.struct_name}_${node.operator_func.func_name}`;
		status.code += `${label}(`;
		build_operand(node.left_value, status);
		status.code += ", ";
		build_operand(node.right_value, status);
		status.code += ")";
	} else {
		build_default_binary(node, status);
	}
}

function build_default_binary(node: OperationNode, status: BuildStatus) {
	// Wrap binary operations in parens so C's precedence can't misinterpret
	// them when they're nested as operands of other expressions.
	status.code += `(`;
	build_node(node.left_value, status);
	status.code += ` ${node.op} `;
	build_node(node.right_value, status);
	status.code += `)`;
}

/** True if one side of an ==/!= is the `null` literal. */
function is_null_comparison(node: OperationNode): boolean {
	const l = node.left_value;
	const r = node.right_value;
	const l_null = l.node_type === "value" && (l as ValueNode).value === "null";
	const r_null = r.node_type === "value" && (r as ValueNode).value === "null";
	return l_null || r_null;
}

function is_nullable_struct_side(node: any, status: BuildStatus): boolean {
	return is_nullable_struct_type(type_from_value_node(node), status);
}

/**
 * Build the companion `_has` flag expression for a nullable-struct lvalue by
 * building the lvalue's C expression and appending `_has`. This works because
 * every nullable-struct lvalue (a bare variable or a `.field`/`->field` access)
 * ends in an identifier.
 */
function build_nullable_has(node: any, status: BuildStatus): string {
	const before = status.code.length;
	build_node(node, status);
	const expr = status.code.substring(before);
	status.code = status.code.substring(0, before);
	return `${expr}_has`;
}

function build_operand(node: any, status: BuildStatus) {
	const param_type = type_from_value_node(node);
	const is_struct =
		status.structs.find((s) => s.name === param_type.name && !s.is_simple_type) ||
		status.traits.find((t) => t.name === param_type.name);
	if (!is_struct) {
		build_node(node, status);
		return;
	}
	// Struct/trait operands are passed by address. If the operand is already an
	// lvalue (a variable or member/element access) we can take its address
	// directly. Otherwise it's an rvalue (e.g. a freshly-constructed struct
	// `M(5)`, an arithmetic result, or a cast) and `&<rvalue>` is invalid C —
	// materialize it into a temporary first via a GCC statement-expression.
	const is_lvalue =
		node.node_type === "value" ||
		node.node_type === "access" ||
		node.node_type === "access_field" ||
		node.node_type === "access_func";
	if (is_lvalue) {
		status.code += `&`;
		build_node(node, status);
	} else {
		const tag = param_type.name;
		status.code += `({ ${tag} _op_tmp = `;
		build_node(node, status);
		status.code += `; &_op_tmp; })`;
	}
}
