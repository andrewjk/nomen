import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import check_block_node from "./check_block_node.ts";
import check_function_parameter_node from "./check_function_parameter_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import clone_status from "./utils/clone_status.ts";
import { materialize_tuple_type } from "./utils/tuple_struct.ts";

function is_generic_func(func: FunctionNode): boolean {
	return func.type_params.length > 0;
}

export default function check_function_node(func: FunctionNode, status: CheckStatus) {
	if (func.checked) return;
	func.checked = true;

	status.functions.push(func);

	if (is_generic_func(func)) {
		func.is_generic = true;
		return;
	}

	let function_status = clone_status(status);
	// Everything inherited from the enclosing scope (now cloned into our
	// `values`) is a capture target: this function may not reference any of
	// those names. Record the boundary so check_value_node can reject such
	// references — Nomen does not implement closures. For a top-level function
	// the enclosing `values` is empty, so the base is 0.
	function_status.function_value_base = function_status.values.length;
	const structs_before = function_status.structs.length;
	const types_before = function_status.types.length;

	for (let param of func.params) {
		check_function_parameter_node(param, function_status);
	}

	if (func.return_type.name) {
		if (!check_type_exists(func.return_type, function_status, func.return_type_start!)) {
			func.return_type = new Type("?");
		} else if (func.return_type.name === "tuple" && func.return_type.tuple_types?.length) {
			func.return_type = materialize_tuple_type(func.return_type, function_status);
		}
	}

	check_block_node(func, function_status);

	// Bubble up any tuple structs (and their types) materialized while
	// checking this function's body so callers can resolve field accesses
	// on returned tuples.
	for (let i = structs_before; i < function_status.structs.length; i++) {
		const s = function_status.structs[i];
		if (!status.structs.includes(s)) {
			status.structs.push(s);
		}
	}
	for (let i = types_before; i < function_status.types.length; i++) {
		const t = function_status.types[i];
		if (!status.types.includes(t)) {
			status.types.push(t);
		}
	}
}
