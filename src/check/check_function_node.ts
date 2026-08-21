import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import check_block_node from "./check_block_node.ts";
import { instantiate_generic_type } from "./check_function_call_node.ts";
import check_function_parameter_node from "./check_function_parameter_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import clone_status from "./utils/clone_status.ts";
import { extract_length_equalities_at_registration } from "./utils/flow_bounds.ts";
import materialize_type from "./utils/materialize_type.ts";

function is_generic_func(func: FunctionNode): boolean {
	return func.type_params.length > 0;
}

export default function check_function_node(func: FunctionNode, status: CheckStatus) {
	if (func.checked) return;
	func.checked = true;

	status.functions.push(func);

	// Strip parallel-length equality clauses (`a.length == b.length`) from
	// every parameter's constraint AT REGISTRATION — before any call site can
	// observe the signature. A forward-referenced callee must not hand its
	// caller a clause no call site could ever prove; the clause becomes an
	// assumed equality for the callee's own body instead (stashed on the
	// param, seeded into scope when its params are checked).
	const param_names = new Set(func.params.map((p) => p.name));
	for (const param of func.params) {
		if (!param.constraint) continue;
		const { constraint, equalities } = extract_length_equalities_at_registration(
			param.constraint,
			param.name,
			param_names,
		);
		if (equalities.length) {
			param.constraint = constraint;
			param.stripped_length_equalities = equalities;
		}
	}

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
	// Parallel-length equations are scoped to the function whose params
	// declared them; a nested function's params may shadow the outer names,
	// so it starts with a clean slate.
	function_status.equal_lengths = [];
	const structs_before = function_status.structs.length;
	const enums_before = function_status.enums.length;
	const types_before = function_status.types.length;

	for (let param of func.params) {
		check_function_parameter_node(param, function_status);
	}

	if (func.return_type.name) {
		if (!check_type_exists(func.return_type, function_status, func.return_type_start!)) {
			func.return_type = new Type("?");
		} else {
			func.return_type = materialize_type(func.return_type, function_status);
		}
		// A generic container used only as a return type (e.g.
		// `out List<string>` with no construction of that exact type) would
		// never be monomorphized, leaving the signature referencing a bare
		// incomplete struct. Materialize it here.
		instantiate_generic_type(func.return_type, function_status);
	}

	check_block_node(func, function_status);

	// Bubble up any tuple structs (and their types) materialized while
	// checking this function's body so callers can resolve field accesses
	// on returned tuples. Enums materialized here (anonymous enums, generic
	// enum monomorphizations) bubble the same way so sibling statements see
	// them in status.enums.
	for (let i = structs_before; i < function_status.structs.length; i++) {
		const s = function_status.structs[i];
		if (!status.structs.includes(s)) {
			status.structs.push(s);
		}
	}
	for (let i = enums_before; i < function_status.enums.length; i++) {
		const e = function_status.enums[i];
		if (!status.enums.includes(e)) {
			status.enums.push(e);
		}
	}
	for (let i = types_before; i < function_status.types.length; i++) {
		const t = function_status.types[i];
		if (!status.types.includes(t)) {
			status.types.push(t);
		}
	}
}
