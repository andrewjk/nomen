import add_error from "../add_error.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { monomorphize } from "./check_function_call_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import {
	find_function_by_params,
	is_overloaded,
	mangled_label,
} from "./utils/function_overload.ts";
import get_null_check_var from "./utils/get_null_check_var.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_operation_node(op: OperationNode, status: CheckStatus): boolean {
	if (op.op === "!") {
		if (!check_node(op.right_value, status)) {
			return false;
		}
		op.type = new Type("bool");
		return true;
	}

	if (op.op === ("&&" as const)) {
		if (!check_node(op.left_value, status)) return false;

		// Short-circuit: narrow is_null when left side is thing != null
		const left_check = get_null_check_var(op.left_value);
		let saved_null: boolean | undefined;
		if (left_check && !left_check.is_null_check) {
			const var_obj = status.values.findLast((v) => v.name === left_check.name);
			if (var_obj && var_obj.is_null) {
				saved_null = var_obj.is_null;
				var_obj.is_null = false;
			}
		}

		if (!check_node(op.right_value, status)) return false;

		// Restore is_null after the condition (else branch shouldn't be narrowed)
		if (saved_null !== undefined && left_check) {
			const var_obj = status.values.findLast((v) => v.name === left_check.name);
			if (var_obj) var_obj.is_null = saved_null;
		}

		op.type = new Type("bool");
		return true;
	}

	const is_equality = op.op === "==" || op.op === "!=";
	const is_null_coalesce = op.op === "??";
	const old_allow_null = status.allow_null_value;
	if (is_equality || is_null_coalesce) {
		status.allow_null_value = true;
	}

	if (!check_node(op.left_value, status)) {
		status.allow_null_value = old_allow_null;
		return false;
	}

	const left_type = type_from_value_node(op.left_value, status);

	const old_expected_type = status.expected_type;
	status.expected_type = left_type;
	const right_result = check_node(op.right_value, status);
	status.expected_type = old_expected_type;
	status.allow_null_value = old_allow_null;
	if (!right_result) {
		return false;
	}

	const right_type = type_from_value_node(op.right_value, status);

	// Check for custom operator on struct (including arrays, which use the Array struct)
	const custom_op = find_custom_operator(op, left_type, right_type, status);
	if (custom_op) {
		const func = custom_op.func;
		// For array types, preserve the element type in the result
		if (left_type.is_array && func.return_type.name === "Array") {
			op.type = new Type(left_type.name);
			op.type.is_array = true;
		} else {
			op.type = func.return_type;
		}
		const struct_name =
			custom_op.mono_struct_name || (left_type.is_array ? "Array" : left_type.name);
		const func_name = operator_to_func_name(op.op) || func.name;
		const struct_node = status.structs.find((s) => s.name === struct_name);
		op.operator_func = {
			struct_name,
			func_name: func.name,
			mangled_name:
				struct_node && is_overloaded(struct_node, func_name)
					? mangled_label(func, struct_name)
					: undefined,
			invert: custom_op.invert,
		};

		// Propagate array length for + and * operations
		if (left_type.is_array && op.type.is_array) {
			const left_len = left_type.length ? parseInt((left_type.length as any).value || "0") : 0;
			const right_val = value_from_value_node(op.right_value);

			if (op.op === "+" && right_type.is_array) {
				const right_len = right_type.length ? parseInt((right_type.length as any).value || "0") : 0;
				op.type.length = new ValueNode(-1, (left_len + right_len).toString(), new Type("int"));
			} else if (op.op === "*" && right_type.name === "int" && /^(\+|-)*\d+$/.test(right_val)) {
				const multiplier = parseInt(right_val);
				op.type.length = new ValueNode(-1, (left_len * multiplier).toString(), new Type("int"));
			}
		}

		return true;
	}

	// If left operand is a non-simple struct and no custom operator was found, it's an error
	// But ref and nullable types can use == and != (comparing pointers or checking null)
	const struct_name = left_type.is_array ? "Array" : left_type.name;
	if (
		status.structs.find((s) => s.name === struct_name && !s.is_simple_type) &&
		!(left_type.is_ref || left_type.is_nullable)
	) {
		add_error(status, `No operator ${op.op as string} defined for type ${struct_name}`, op.start);
		return false;
	}

	check_type_and_value_match(
		left_type,
		right_type,
		value_from_value_node(op.right_value),
		status,
		op.right_value.start,
		"operation",
	);

	// HACK: this needs to come from operator funcs for each operator and type combination
	switch (op.op) {
		case "+":
		case "-":
		case "*":
		case "/":
		case "%":
		case "<<":
		case ">>":
		case "&":
		case "|":
		case "^": {
			op.type = left_type;
			break;
		}
		case "==":
		case "!=":
		case ">":
		case ">=":
		case "<":
		case "<=":
		case "||": {
			op.type = new Type("bool");
			break;
		}
		case "??": {
			const result_type = new Type(
				left_type.name,
				left_type.is_static,
				left_type.is_array,
				left_type.length,
			);
			result_type.type_args = left_type.type_args;
			result_type.is_ref = left_type.is_ref;
			op.type = result_type;
			break;
		}
		default: {
			add_error(status, `Unknown operator: ${op.op as string}`, op.start);
			return false;
		}
	}

	return true;
}

function find_custom_operator(
	op: OperationNode,
	left_type: Type,
	right_type: Type,
	status: CheckStatus,
): { func: FunctionNode; mono_struct_name?: string; invert?: boolean } | undefined {
	// For array types, look up operators on the Array struct
	const struct_name = left_type.is_array ? "Array" : left_type.name;
	if (!struct_name) {
		return undefined;
	}

	let struct = status.structs.find((s) => s.name === struct_name);
	if (!struct) {
		return undefined;
	}

	const func_name = operator_to_func_name(op.op);
	if (!func_name) {
		return undefined;
	}

	// For generic Array struct with arrays, monomorphize for the element type
	let mono_struct_name: string | undefined;
	if (struct.type_params.length > 0 && left_type.is_array) {
		const elem_type = new Type(left_type.name);
		const mono = monomorphize(struct, [elem_type], status);
		if (mono) {
			mono_struct_name = mono.name;
			struct = mono;
		}
	}

	let func = find_function_by_params(struct.functions, func_name, [right_type]);
	let invert = false;
	// Equality operators are duals: if the struct defines `eq` but not `ne`
	// (or vice versa), the missing one is derived as the logical negation of
	// the present one. So writing only `#op_eq` gives you both `==` and `!=`.
	if (!func && (op.op === "==" || op.op === "!=")) {
		const dual_name = op.op === "==" ? "ne" : "eq";
		const dual = find_function_by_params(struct.functions, dual_name, [right_type]);
		if (dual) {
			func = dual;
			invert = true;
		}
	}
	if (!func) {
		return undefined;
	}

	// Validate that the function has a non-self parameter matching the right operand type
	const non_self_params = func.params.filter((p) => !p.is_self_param);
	if (non_self_params.length !== 1) {
		add_error(
			status,
			`Operator function ${func_name} must take exactly one parameter (plus self)`,
			op.start,
		);
		return undefined;
	}

	const other_param = non_self_params[0];
	// For array operators, Array struct parameters accept any array type
	const param_type = other_param.type;
	if (param_type.name === "Array" && !param_type.is_array && right_type.is_array) {
		// Array struct parameter matches any array type
	} else {
		check_type_and_value_match(
			param_type,
			right_type,
			value_from_value_node(op.right_value),
			status,
			op.right_value.start,
			"param",
		);
	}

	return { func, mono_struct_name, invert };
}

function operator_to_func_name(op: string): string | undefined {
	switch (op) {
		case "+":
			return "add";
		case "-":
			return "sub";
		case "*":
			return "mul";
		case "/":
			return "div";
		case "%":
			return "mod";
		case "==":
			return "eq";
		case "!=":
			return "ne";
		default:
			return undefined;
	}
}
