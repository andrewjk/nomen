import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { monomorphize } from "./check_function_call_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import evaluate_const_condition, {
	evaluate_numeric_or_bool,
} from "./utils/evaluate_const_condition.ts";
import {
	apply_bounds,
	collect_return_bounds,
	path_to_node,
	record_buffer_cap,
	substitute_constraint,
} from "./utils/flow_bounds.ts";
import is_visible from "./utils/is_visible.ts";
import { is_class_type } from "./utils/ownership.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

/**
 * Core data structures whose internals maintain length<=cap invariants or use
 * computed indices that flow analysis can't always prove. When we're checking
 * a call inside one of these structs' methods, unverifiable Buffer constraints
 * are silently allowed (the data structure is trusted to maintain its own
 * invariants).
 */
const CORE_DATA_STRUCTURES = new Set(["Buffer", "BigInt"]);

/**
 * Walk the checking stack to find the nearest enclosing FunctionNode and check
 * whether its scope is a method of a core data structure.
 */
function is_inside_core_method(status: CheckStatus): boolean {
	for (let i = status.stack.length - 1; i >= 0; i--) {
		const node = status.stack[i];
		if (node.node_type === "func") {
			const func = node as FunctionNode;
			const scope = func.scope as StructNode | undefined;
			if (scope && scope.node_type === "struct" && CORE_DATA_STRUCTURES.has(scope.name)) {
				return true;
			}
			// Also check the function name prefix for monomorphized structs
			// (e.g. List_int's methods still belong to a core data structure)
			if (scope && scope.node_type === "struct") {
				const base = scope.name.split("_")[0];
				if (CORE_DATA_STRUCTURES.has(base)) return true;
			}
			// Found the nearest function but it's not a core method — stop walking
			return false;
		}
	}
	return false;
}

export default function check_function_call(
	node: FunctionCallNode | AccessFunctionCallNode,
	status: CheckStatus,
	func: FunctionNode,
	target_type?: Type,
	self_value?: string,
	self_path?: string,
): boolean {
	const access_scope = status.stack.at(-1)!;
	// For init functions, check the struct's visibility
	if (func.name === "#init") {
		const struct_name = target_type?.name || func.return_type.name;
		const struct = status.structs.find((s) => s.name === struct_name);
		if (
			struct &&
			struct.visibility === "private" &&
			!is_visible(struct.scope, struct.visibility, access_scope, status.stack)
		) {
			add_error(status, `Can't access private function: ${node.name}`, node.start);
			return false;
		}
	} else if (
		func.visibility === "private" &&
		!is_visible(func.scope, func.visibility, access_scope, status.stack)
	) {
		add_error(status, `Can't access private function: ${node.name}`, node.start);
		return false;
	}

	node.type = func.return_type;
	node.is_static = func.is_static;

	const variadic_param_index = func.params.findIndex((p) => p.is_variadic);

	let required_param_count = 0;
	for (const param of func.params) {
		if (param.is_variadic) continue;
		if (!param.default_value) {
			required_param_count++;
		}
	}
	if (func.params[0]?.is_self_param) {
		required_param_count -= 1;
	}

	const non_variadic_param_count = func.params.filter((p) => !p.is_variadic).length;
	const variadic_arg_count =
		variadic_param_index >= 0 ? node.params.length - non_variadic_param_count : 0;

	if (variadic_param_index >= 0 && variadic_arg_count < 0) {
		add_error(status, `Parameters missing for function: ${node.name}`, node.start);
		return false;
	} else if (variadic_param_index < 0 && node.params.length > func.params.length) {
		add_error(status, `Too many parameters for function: ${node.name}`, node.start);
		return false;
	} else if (node.params.length < required_param_count) {
		add_error(status, `Parameters missing for function: ${node.name}`, node.start);
		return false;
	}

	if (variadic_param_index >= 0) {
		const variadic_elem_type = func.params[variadic_param_index].type;
		const variadic_args = node.params.splice(variadic_param_index, variadic_arg_count);
		const array_node = new ArrayValuesNode(variadic_args[0]?.start ?? 0, variadic_args);
		array_node.type = new Type(variadic_elem_type.name);
		array_node.type.is_array = true;
		node.params.splice(variadic_param_index, 0, array_node);
		node.variadic_param_name = func.params[variadic_param_index].name;
		(node as FunctionCallNode).variadic_param_index = variadic_param_index;
	}

	while (node.params.length < func.params.length) {
		const missing_param = func.params[node.params.length];
		if (missing_param.default_value) {
			node.params.push(missing_param.default_value);
		} else {
			break;
		}
	}

	status.stack.push(node);

	const self_offset = func.params[0]?.is_self_param ? 1 : 0;

	for (let i = 0; i < node.params.length; i++) {
		const param = node.params[i];
		if (param.node_type !== "anon_struct") continue;
		const func_param = func.params[i + self_offset];
		if (!func_param) continue;
		let struct = status.structs.findLast((s) => s.name === func_param.type.name);
		if (!struct) {
			add_error(status, `Unknown struct type: ${func_param.type.name}`, param.start);
			continue;
		}
		const anon = param as AnonStructNode;

		if (struct.is_generic && !func_param.type.type_args?.length) {
			const type_map = new Map<string, Type>();
			for (const af of anon.fields) {
				if (!check_node(af.value, status)) continue;
				const val_type = type_from_value_node(af.value, status);
				const struct_field = struct.fields.find((f) => f.name === af.name);
				if (struct_field && struct.type_params.includes(struct_field.type.name)) {
					if (!type_map.has(struct_field.type.name)) {
						type_map.set(struct_field.type.name, val_type);
					}
				}
			}
			if (type_map.size > 0) {
				const inferred_args = struct.type_params.map((tp) => type_map.get(tp) || new Type(tp));
				const mono_name = struct.name + "_" + inferred_args.map((t) => t.name).join("_");
				let mono = status.structs.find((s) => s.name === mono_name);
				if (!mono) {
					mono = monomorphize(struct, inferred_args, status) ?? undefined;
				}
				if (mono) {
					struct = mono;
				}
			}
		}

		const init_func = struct.functions.find((f) => f.name === "#init");
		if (!init_func) {
			add_error(status, `Struct ${struct.name} has no init`, param.start);
			continue;
		}
		const args: BaseNode[] = [];
		for (const init_param of init_func.params) {
			const field = anon.fields.find((f) => f.name === init_param.name);
			if (field) {
				args.push(field.value);
			} else if (init_param.default_value) {
				args.push(init_param.default_value);
			} else {
				add_error(status, `Missing field '${init_param.name}' in anonymous struct`, param.start);
			}
		}
		for (const field of anon.fields) {
			if (!init_func.params.find((p) => p.name === field.name)) {
				add_error(
					status,
					`Unknown field '${field.name}' in anonymous struct for ${struct.name}`,
					param.start,
				);
			}
		}
		const constructor = new FunctionCallNode(param.start, struct.name);
		constructor.params = args;
		constructor.type = new Type(struct.name);
		node.params.splice(i, 1, constructor);
	}

	// Collect argument values for constraint evaluation (all params, not just current)
	// Collect argument values for constraint evaluation
	// (all params, since constraints can reference other params like source.length)
	const constraint_args: {
		name: string;
		type: Type;
		value: number | boolean | undefined;
		range_lower?: number;
		range_upper?: number;
		upper_bound_exprs?: string[];
		lower_bound_exprs?: string[];
		upper_bound_expr?: string;
		lower_bound_expr?: string;
	}[] = [];

	for (let [i, param] of node.params.entries()) {
		const func_param = func.params[i + self_offset];

		// Set expected_type to the function parameter's type so that
		// untyped values (e.g. array literals) are inferred correctly,
		// rather than leaking the outer declaration's expected_type.
		const old_expected_type = status.expected_type;
		if (func_param) {
			status.expected_type = func_param.type;
		}

		if (!check_node(param, status)) {
			status.expected_type = old_expected_type;
			continue;
		}
		status.expected_type = old_expected_type;

		const param_type = type_from_value_node(param, status);
		const param_value = value_from_value_node(param);
		const has_ref_keyword = node.ref_param_indices?.includes(i) ?? false;
		const has_mov_keyword = node.mov_param_indices?.includes(i) ?? false;
		if (func_param.type.is_ref && !has_ref_keyword) {
			add_error(
				status,
				`Missing 'ref' keyword for ref parameter '${func_param.name}'`,
				param.start,
			);
		} else if (!func_param.type.is_ref && has_ref_keyword) {
			add_error(
				status,
				`Unexpected 'ref' keyword for non-ref parameter '${func_param.name}'`,
				param.start,
			);
		}
		// Only require explicit 'mov' keyword at the call site when the
		// parameter is a class type AND the argument is a variable (has a
		// name to invalidate). For temporaries (function call results,
		// literals) and non-class types, mov is implicit or a no-op.
		const param_is_class = func_param.type.name && is_class_type(func_param.type.name, status);
		const arg_is_variable = param.node_type === "value";
		if (func_param.is_moved && !has_mov_keyword && param_is_class && arg_is_variable) {
			add_error(
				status,
				`Missing 'mov' keyword for mov parameter '${func_param.name}'`,
				param.start,
			);
		} else if (!func_param.is_moved && has_mov_keyword) {
			add_error(
				status,
				`Unexpected 'mov' keyword for non-mov parameter '${func_param.name}'`,
				param.start,
			);
		}
		// mov is allowed on any type at the call site. Only invalidate the
		// caller's variable when the parameter type is a class — for non-class
		// types (int, struct, etc.), mov is a no-op.
		if (has_mov_keyword && param_value && !node.swap_params?.has(i)) {
			if (func_param.type.name && is_class_type(func_param.type.name, status)) {
				if (!status.moved_variables) status.moved_variables = new Set();
				status.moved_variables.add(param_value);
			}
		}
		if (
			has_mov_keyword &&
			!node.swap_params?.has(i) &&
			param.node_type === "access" &&
			(param as AccessNode).access.node_type === "access_field"
		) {
			const access = param as AccessNode;
			const field_type = type_from_value_node(access.access, status);
			if (field_type.name && is_class_type(field_type.name, status)) {
				const field_name = (access.access as AccessFieldNode).name;
				add_error(
					status,
					`cannot mov '${field_name}' out of struct — struct owns its class fields`,
					param.start,
				);
			}
		}
		const swap_expr = node.swap_params?.get(i);
		if (swap_expr) {
			if (!has_mov_keyword) {
				add_error(status, `swap requires mov keyword`, swap_expr.start);
			} else {
				check_node(swap_expr, status);
				const swap_type = type_from_value_node(swap_expr, status);
				check_type_and_value_match(
					param_type,
					swap_type,
					undefined,
					status,
					swap_expr.start,
					"swap",
				);
			}
		}
		// For variadic params, the packed array type is T[] but func_param.type is T
		let expected_type = func_param.type;
		if (func_param.is_variadic) {
			expected_type = new Type(func_param.type.name);
			expected_type.is_array = true;
		}
		check_type_and_value_match(
			expected_type,
			param_type,
			param_value,
			status,
			param.start,
			"param",
		);

		if (param_type.is_array && param_type.length && !func_param.type.length) {
			func_param.type.length = param_type.length;
		}

		// Collect argument for constraint evaluation
		let arg_value: number | boolean | undefined;
		if (param.node_type === "value") {
			const vn = param as ValueNode;
			if (/^[+-]?\d+$/.test(vn.value)) arg_value = parseInt(vn.value, 10);
			if (vn.value === "true") arg_value = true;
			if (vn.value === "false") arg_value = false;
			// Check for const variable references
			if (arg_value === undefined) {
				const decl = status.values.findLast((v) => v.name === vn.value);
				if (decl && typeof decl.const_value === "number") {
					arg_value = decl.const_value;
				}
			}
		}
		if (arg_value === undefined) {
			const evaluated = evaluate_numeric_or_bool(param, status);
			if (typeof evaluated === "number" || typeof evaluated === "boolean") {
				arg_value = evaluated;
			}
		}
		// Look up range info from the original variable (e.g. for-loop range variables)
		let range_lower: number | undefined;
		let range_upper: number | undefined;
		let upper_bound_exprs: string[] | undefined;
		let lower_bound_exprs: string[] | undefined;
		let upper_bound_expr: string | undefined;
		let lower_bound_expr: string | undefined;
		if (param.node_type === "value") {
			const decl = status.values.findLast((v) => v.name === (param as ValueNode).value);
			if (decl) {
				range_lower = decl.range_lower;
				range_upper = decl.range_upper;
				upper_bound_exprs = decl.upper_bound_exprs;
				lower_bound_exprs = decl.lower_bound_exprs;
				upper_bound_expr = decl.upper_bound_expr;
				lower_bound_expr = decl.lower_bound_expr;
			}
		}
		// Fold in bounds propagated from a nested call's return contract, so a
		// parameter constraint can verify against an inline call result
		// (e.g. `g.at(g.edge_target(e))`). Method calls arrive as an AccessNode
		// wrapping an AccessFunctionCallNode; free calls arrive directly.
		let nested_rb: { upper: string[]; lower: string[] } | undefined;
		if (param.node_type === "func_call" || param.node_type === "access_func") {
			nested_rb = (param as FunctionCallNode).return_bounds;
		} else if (
			param.node_type === "access" &&
			(param as AccessNode).access.node_type === "access_func"
		) {
			nested_rb = ((param as AccessNode).access as AccessFunctionCallNode).return_bounds;
		}
		if (nested_rb) {
			upper_bound_exprs = [...(upper_bound_exprs ?? []), ...nested_rb.upper];
			lower_bound_exprs = [...(lower_bound_exprs ?? []), ...nested_rb.lower];
		}
		constraint_args.push({
			name: func_param.name,
			type: param_type,
			value: arg_value,
			range_lower,
			range_upper,
			upper_bound_exprs,
			lower_bound_exprs,
			upper_bound_expr,
			lower_bound_expr,
		});

		// Evaluate constraints that reference this or earlier parameters
		if (func_param.constraint) {
			const saved_values_length = status.values.length;
			for (const ca of constraint_args) {
				status.values.push({
					declaration: "const",
					name: ca.name,
					type: ca.type,
					is_set: true,
					const_value: ca.value,
					range_lower: ca.range_lower,
					range_upper: ca.range_upper,
					upper_bound_exprs: ca.upper_bound_exprs,
					lower_bound_exprs: ca.lower_bound_exprs,
					upper_bound_expr: ca.upper_bound_expr,
					lower_bound_expr: ca.lower_bound_expr,
				});
			}
			// Push self so constraints can reference self.length
			if (self_value && self_value !== "?") {
				const self_type = target_type || func.params[0]?.type;
				// self_path is the full access path (e.g. "self.items" for
				// `self.items.load_int(...)`), so self.cap resolves correctly
				// to "self.items.cap" when matching against flow bounds.
				status.values.push({
					declaration: "const",
					name: "self",
					type: self_type,
					is_set: true,
					alias_of: self_path ?? self_value,
				});
			}

			const satisfied = evaluate_const_condition(func_param.constraint, status);
			status.values.length = saved_values_length;

			if (satisfied === false) {
				add_error(status, `Parameter constraint not satisfied: ${func_param.name}`, param.start);
			} else if (satisfied === undefined) {
				// Constraint can't be verified at compile time (e.g. runtime variable index).
				// For self constraints on core library types (arrays, strings, Buffer), allow
				// silently since the constraint references self.length/self.cap which may
				// legitimately be unknown. The flow analysis (flow_bounds.ts) verifies these
				// when possible (e.g. `while i < buf.get_cap()` inside the loop body).
				// For user-defined functions, emit an error since the constraint can't be
				// verified. Also allow silently when the call site is inside another core
				// data structure's method — those types maintain their own invariants.
				const base_name = target_type?.name?.split("_")[0] ?? "";
				const core_types = ["Array", "Buffer", "BigInt"];
				const is_core_method =
					target_type?.is_array ||
					target_type?.name === "string" ||
					target_type?.name === "Buffer" ||
					core_types.includes(base_name);
				const inside_core = is_inside_core_method(status);
				if (!is_core_method && !inside_core) {
					add_error(
						status,
						`Parameter constraint cannot be verified: ${func_param.name}`,
						param.start,
					);
				}
			}
		}

		if (
			param.node_type !== "value" &&
			!has_ref_keyword &&
			!node.swap_params?.has(i) &&
			!(i === (node as FunctionCallNode).variadic_param_index && param.node_type === "array")
		) {
			const declaration_name = `_param_${status.var_name_counter.value++}`;
			status.allocations.push(
				new DeclarationNode(param.start, "private", "const", declaration_name, param_type, param),
			);
			node.params.splice(i, 1, new ValueNode(param.start, declaration_name, param_type));
		}
	}
	// Check for parameter aliasing: struct params are passed by pointer.
	// Track all struct params; when a mutable param (var/mov/ref) shares the
	// same variable as any previously-seen struct param (const or mutable),
	// flag aliasing — mutation can cause use-after-free or corrupted reads.
	const self_param = func.params[0];
	const self_is_struct =
		self_param?.is_self_param &&
		status.structs.find((s) => s.name === self_param.type.name && !s.is_simple_type);
	const self_is_mutable =
		self_is_struct && (self_param.type?.is_ref || self_param.declaration === "var");

	const struct_param_seen: Map<string, string> = new Map();

	// Track self separately — we check it against mutable params,
	// but don't add it to the general map (avoids false positives on
	// patterns like a.add_to(a, b) where self aliases with a const param).
	let self_tracked_value: string | null = null;
	if (self_value && self_value !== "?" && self_is_mutable) {
		self_tracked_value = self_value;
	}

	for (let i = 0; i < node.params.length; i++) {
		const param = node.params[i];
		const func_param = func.params[i + self_offset];
		if (!func_param) continue;

		const is_struct = !!status.structs.find(
			(s) => s.name === func_param.type.name && !s.is_simple_type,
		);
		if (!is_struct) continue;

		const val = value_from_value_node(param);
		if (val === "?") continue;

		const is_mutable =
			func_param.declaration === "var" || func_param.is_moved || func_param.type?.is_ref;

		if (is_mutable) {
			// Check self aliasing first
			if (self_tracked_value === val) {
				add_error(
					status,
					`Aliasing: '${val}' passed as both 'self' and '${func_param.name}' — mutable parameter aliasing can cause use-after-free`,
					param.start,
				);
			} else if (struct_param_seen.has(val)) {
				const prev = struct_param_seen.get(val)!;
				add_error(
					status,
					`Aliasing: '${val}' passed as both '${prev}' and '${func_param.name}' — mutable parameter aliasing can cause use-after-free`,
					param.start,
				);
			}
		}

		struct_param_seen.set(val, func_param.name);
	}

	// Record known minimum capacity for Buffer after grow/alloc calls.
	// This lets subsequent `buf.store_int(0, …)` verify `0 < buf.cap`.
	// Covers void-style calls where the return value isn't captured.
	if (self_path && self_path !== "?" && target_type?.name === "Buffer" && func.return_constraint) {
		const size_param = node.params[0];
		if (size_param) {
			const size_val = evaluate_numeric_or_bool(size_param, status);
			if (typeof size_val === "number" && size_val > 0) {
				record_buffer_cap(self_path, size_val, status);
			}
		}
	}

	// Propagate return contract (`out TYPE: out < cap`) to the caller's LHS.
	// Walk up the stack to find the enclosing declaration/assignment so we
	// know which variable to bind.
	if (func.return_constraint) {
		const param_to_arg = new Map<string, BaseNode>();
		// Map `self` onto the caller's receiver path so return contracts that
		// reference self.X (e.g. `out < self.count`) resolve at the call site
		// (e.g. `cur < list.count`), giving the LHS variable a tracked bound.
		if (self_path && self_path !== "?") {
			param_to_arg.set("self", path_to_node(self_path));
		}
		for (let i = 0; i < node.params.length; i++) {
			const fp = func.params[i + self_offset];
			if (fp?.name) {
				param_to_arg.set(fp.name, node.params[i]);
			}
		}
		// `out` placeholder; the bound expressions are extracted regardless of
		// the name used for the return value.
		const substituted = substitute_constraint(func.return_constraint, "_return", param_to_arg);
		// Always resolve the return contract to concrete bound expressions on
		// the call node, so an enclosing call can verify a parameter constraint
		// against this call's result even when it isn't captured in a variable
		// (e.g. `g.at(g.edge_target(e))`).
		node.return_bounds = collect_return_bounds(substituted, status);

		const lhs_name = find_lhs_var_name(status);
		if (lhs_name) {
			// Re-substitute with the real LHS name so the bound is keyed to the
			// variable being assigned/declared.
			const bound = substitute_constraint(func.return_constraint, lhs_name, param_to_arg);
			if (status.values.some((v) => v.name === lhs_name)) {
				// Assignment to an existing variable — bind immediately.
				apply_bounds(bound, status);
			} else {
				// Declaration in progress: the variable isn't in scope yet, so
				// stash the bound for check_declaration_node to apply once it
				// pushes the variable.
				if (!status.pending_return_bounds) status.pending_return_bounds = new Map();
				let arr = status.pending_return_bounds.get(lhs_name);
				if (!arr) {
					arr = [];
					status.pending_return_bounds.set(lhs_name, arr);
				}
				arr.push(bound);
			}
		}
	}

	status.stack.pop();
	return true;
}

/**
 * Walk the checking stack to find the name of the variable being assigned
 * by the nearest enclosing DeclarationNode or AssignmentNode. Returns
 * undefined if the call's result isn't being captured by a named variable.
 */
function find_lhs_var_name(status: CheckStatus): string | undefined {
	for (let i = status.stack.length - 1; i >= 0; i--) {
		const node = status.stack[i];
		if (node.node_type === "declare") {
			const decl = node as DeclarationNode;
			return decl.name;
		}
		if (node.node_type === "assign") {
			const assign = node as import("../nodes/AssignmentNode.ts").default;
			if (assign.left_value?.node_type === "value") {
				return (assign.left_value as ValueNode).value;
			}
			return undefined;
		}
		// Don't walk past a function boundary — the LHS belongs to a
		// different function context.
		if (node.node_type === "func") return undefined;
	}
	return undefined;
}
