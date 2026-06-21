import add_error from "../add_error.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import evaluate_const_condition from "./utils/evaluate_const_condition.ts";
import { is_class_type } from "./utils/ownership.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_declaration_node(decl: DeclarationNode, status: CheckStatus) {
	if (decl.func_params) {
		if (decl.func_return_type) {
			check_type_exists(decl.func_return_type, status, -1);
		}
		for (const param of decl.func_params) {
			if (param.type.name) {
				check_type_exists(param.type, status, param.type_start!);
			}
		}

		if (decl.value && decl.value.node_type === "func") {
			for (const param of decl.func_params) {
				status.values.push({
					declaration: param.declaration,
					name: param.name,
					type: param.type,
					is_set: true,
				});
			}
			status.stack.push(decl);
			check_node(decl.value, status);
			status.stack.pop();
			return;
		} else if (decl.value) {
			status.stack.push(decl);

			convert_anon_struct(decl, status);

			const old_expected_type = status.expected_type;
			status.expected_type = decl.type;
			const result = check_node(decl.value, status);
			status.expected_type = old_expected_type;

			if (result) {
				check_type_and_value_match(
					decl.type,
					type_from_value_node(decl.value, status),
					value_from_value_node(decl.value),
					status,
					decl.value.start,
					"declaration",
				);
			}

			if (!decl.type.name) {
				decl.type = type_from_value_node(decl.value, status);
			} else if (decl.type.is_array && decl.value.node_type === "array") {
				const value_type = type_from_value_node(decl.value, status);
				if (value_type.is_array && value_type.length) {
					decl.type.length = value_type.length;
				}
			}

			status.stack.pop();
		}

		status.values.push({
			declaration: decl.declaration,
			name: decl.name,
			type: decl.func_return_type || decl.type,
			is_set: !!decl.value,
			start: decl.start,
			is_null: decl.value?.node_type === "value" && (decl.value as any).value === "null",
			const_value: decl.declaration === "const" ? extract_const_value(decl.value) : undefined,
			constraint: decl.constraint,
		});
	} else {
		if (decl.type.name) {
			check_type_exists(decl.type, status, decl.type_start!);
		}

		// Check for var on class-type fields in classes/traits (must use mov)
		if (
			decl.declaration === "var" &&
			decl.type.name &&
			is_class_type(decl.type.name, status) &&
			(decl.scope?.node_type === "struct" || decl.scope?.node_type === "trait")
		) {
			add_error(status, `class-type fields must use 'mov', not 'var'`, decl.start);
		}

		if (decl.value) {
			status.stack.push(decl);

			convert_anon_struct(decl, status);

			const old_expected_type = status.expected_type;
			status.expected_type = decl.type;
			const result = check_node(decl.value, status);
			status.expected_type = old_expected_type;

			if (result) {
				check_type_and_value_match(
					decl.type,
					type_from_value_node(decl.value, status),
					value_from_value_node(decl.value),
					status,
					decl.value.start,
					"declaration",
				);
			}

			if (!decl.type.name) {
				decl.type = type_from_value_node(decl.value, status);
			} else if (decl.type.is_array && decl.value.node_type === "array") {
				const value_type = type_from_value_node(decl.value, status);
				if (value_type.is_array && value_type.length) {
					decl.type.length = value_type.length;
				}
			}

			status.stack.pop();
		}

		check_constraint(decl, status);

		status.values.push({
			declaration: decl.declaration,
			name: decl.name,
			type: decl.type,
			is_set: !!decl.value,
			start: decl.start,
			is_null: decl.value?.node_type === "value" && (decl.value as any).value === "null",
			const_value: decl.declaration === "const" ? extract_const_value(decl.value) : undefined,
			constraint: decl.constraint,
		});
	}
}

function convert_anon_struct(decl: DeclarationNode, status: CheckStatus) {
	if (decl.value?.node_type !== "anon_struct") return;
	const struct = status.structs.findLast((s) => s.name === decl.type.name);
	if (!struct) return;
	const anon = decl.value as AnonStructNode;
	const init_func = struct.functions.find((f) => f.name === "#init");
	if (!init_func) return;
	const args: import("../nodes/BaseNode.ts").default[] = [];
	for (const init_param of init_func.params) {
		const field = anon.fields.find((f) => f.name === init_param.name);
		if (field) {
			args.push(field.value);
		} else if (init_param.default_value) {
			args.push(init_param.default_value);
		}
	}
	for (const field of anon.fields) {
		if (!init_func.params.find((p) => p.name === field.name)) {
			return;
		}
	}
	const constructor = new FunctionCallNode(anon.start, struct.name);
	constructor.params = args;
	constructor.type = new Type(struct.name);
	decl.value = constructor;
}

/**
 * Check that a declaration's value satisfies its constraint (if any).
 * Only checks compile-time constant values.
 */
function check_constraint(decl: DeclarationNode, status: CheckStatus) {
	if (!decl.constraint) return;

	// Type-check the constraint expression and verify it's boolean
	const saved_length = status.values.length;
	status.values.push({
		declaration: "const",
		name: decl.name,
		type: decl.type,
		is_set: true,
	});
	check_node(decl.constraint, status);
	const constraint_type = type_from_value_node(decl.constraint, status);
	if (constraint_type.name && constraint_type.name !== "bool") {
		add_error(
			status,
			`Constraint must be a boolean expression, got ${constraint_type.name}`,
			decl.constraint.start,
		);
	}

	// Check compile-time constant value (only if value exists)
	if (!decl.value) {
		status.values.length = saved_length;
		return;
	}

	let arg_value: number | boolean | undefined;
	if (decl.value.node_type === "value") {
		const vn = decl.value as ValueNode;
		if (/^[+-]?\d+$/.test(vn.value)) arg_value = parseInt(vn.value, 10);
		if (vn.value === "true") arg_value = true;
		if (vn.value === "false") arg_value = false;
	}

	if (arg_value === undefined) {
		status.values.length = saved_length;
		return;
	}

	// Update the const_value for evaluation
	(status.values[status.values.length - 1] as any).const_value = arg_value;

	const satisfied = evaluate_const_condition(decl.constraint, status);
	status.values.length = saved_length;

	if (satisfied === false) {
		add_error(status, `Constraint not satisfied: ${decl.name}`, decl.value.start);
	}
}

/**
 * Extract a compile-time literal value from a declaration's initializer node.
 * Returns a number, string, or boolean for simple literals; undefined otherwise.
 */
function extract_const_value(
	value: import("../nodes/BaseNode.ts").default | undefined,
): number | string | boolean | undefined {
	if (!value || value.node_type !== "value") return undefined;
	const vn = value as ValueNode;
	if (vn.value === "true") return true;
	if (vn.value === "false") return false;
	if (/^[+-]?\d+$/.test(vn.value)) return parseInt(vn.value, 10);
	if (/^[+-]?\d+\.\d+$/.test(vn.value)) return parseFloat(vn.value);
	return undefined;
}
