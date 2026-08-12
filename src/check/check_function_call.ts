import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { borrow_depth_of } from "./utils/borrow.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import evaluate_const_condition, {
	evaluate_numeric_or_bool,
	NON_NEGATIVE_FIELDS,
} from "./utils/evaluate_const_condition.ts";
import {
	apply_bounds,
	collect_return_bounds,
	collect_return_length,
	expr_to_string,
	numeric_interval,
	path_to_node,
	record_buffer_cap,
	substitute_constraint,
} from "./utils/flow_bounds.ts";
import is_visible from "./utils/is_visible.ts";
import { is_class_type, is_owning_ref_type } from "./utils/ownership.ts";
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
 * Whether `type` is a heap `Array<T>`. `Array<T>` is parse-rewritten to
 * `{name: T, is_array: true, is_array_heap: true}` — the flag distinguishes it
 * deterministically from a raw `T[]`/`T[N]` stack array and from an
 * array-literal VALUE (both plain `is_array`). A length-bearing type is a
 * stack array, not a heap Array. Used to (a) avoid stamping a caller's literal
 * length onto a dynamic `Array<T>` param, and (b) decide whether a hoisted
 * array-literal/range/stack-var arg must be materialised as a heap array.
 */
function is_heap_array_type(type: Type | undefined): boolean {
	return !!type?.is_array && !!type.is_array_heap && !type.is_view;
}

/**
 * Whether a call argument is a stack-array VARIABLE (a value reference whose
 * type carries a compile-time `length`) bound to a heap `Array<T>` param. Such
 * args are copied into a heap `Array_<T>` temp at the call site — the param
 * promotes to `struct Array_<T>*`, so passing the stack array directly would
 * misalign `.length`/`.at`/iteration. `ref` params are excluded (their
 * mutation must propagate to the caller's variable, which a copy can't do —
 * those stay a compile-time mismatch, as before).
 */
function is_heap_array_var_copy(
	param: BaseNode,
	func_param: ParameterNode | undefined,
	param_type: Type,
	status: CheckStatus,
): boolean {
	if (param.node_type !== "value") return false;
	if (!is_heap_array_type(func_param?.type)) return false;
	// A heap `Array<T>` arg (is_array_heap) is already a `struct Array_<T>*`
	// and is forwarded directly — only a raw stack-array var (plain `is_array`
	// with a compile-time `length`) needs a copy.
	if (!param_type.is_array || !param_type.length || param_type.is_array_heap) return false;
	// Owning-element stack arrays are not copied: a class-element source owns
	// fresh instances the copy would share (double-free on destroy), and a
	// value-struct element can't be word-copied soundly on the aarch64 backend.
	// They keep the previous (compile-mismatch) behaviour instead.
	const elem_struct = status.structs.find((s) => s.name === param_type.name);
	if (elem_struct && (elem_struct.is_class || !elem_struct.is_simple_type)) return false;
	const name = (param as ValueNode).value;
	// A bare literal / null cannot be a stack-array variable; a value node
	// with an array type and a compile-time length is a stack-array local or
	// a `const` array global reference.
	return (
		name !== "null" && !/^[+-]?\d+$/.test(name) && !name.startsWith('"') && !name.startsWith("'")
	);
}

/**
 * Shift a bound expression string (`base`, `base - a`, `base + a`) by a
 * constant `c`, combining offsets numerically: `(base - a) + c` → `base - (a - c)`.
 * This keeps bounds in a canonical `base ± offset` form so symbolic
 * implication (evaluate_const_condition.ts) can compare them.
 */
function shift_offset_expr(expr: string, c: number): string {
	if (c === 0) return expr;
	// Parse to a SIGNED offset so shifting combines correctly:
	// "base - 5" → -5; "base + 3" → +3; "base" → 0.
	let signed = 0;
	let base = expr;
	let m = expr.match(/^(\w+(?:\.\w+)*)\s*-\s*(\d+)$/);
	if (m) {
		base = m[1];
		signed = -parseInt(m[2], 10);
	} else {
		m = expr.match(/^(\w+(?:\.\w+)*)\s*\+\s*(\d+)$/);
		if (m) {
			base = m[1];
			signed = parseInt(m[2], 10);
		}
	}
	const off = signed + c;
	if (off === 0) return base;
	return `${base} ${off > 0 ? "+" : "-"} ${Math.abs(off)}`;
}

/**
 * Walk the checking stack to find the nearest enclosing FunctionNode and check
 * whether its scope is a method of a core data structure.
 */
function is_inside_core_method(status: CheckStatus): boolean {
	for (let i = status.stack.length - 1; i >= 0; i--) {
		const node = status.stack[i];
		if (node.node_type === "func") {
			const func = node as FunctionNode;
			// Trust all code defined in the appended System library source — it
			// maintains its own bounds invariants (e.g. Json, Regex, ziglings).
			if (func.is_library) return true;
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
	const self_offset = func.params[0]?.is_self_param ? 1 : 0;

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

	// Count non-variadic params EXCLUDING self: the call site doesn't pass
	// self, so its arg list aligns with func params minus the self slot.
	const non_variadic_param_count = func.params.filter(
		(p) => !p.is_variadic && !p.is_self_param,
	).length;
	const variadic_arg_count =
		variadic_param_index >= 0 ? node.params.length - non_variadic_param_count : 0;

	if (variadic_param_index >= 0 && variadic_arg_count < 0) {
		add_error(status, `Parameters missing for function: ${node.name}`, node.start);
		return false;
	} else if (variadic_param_index < 0 && node.params.length > func.params.length - self_offset) {
		add_error(status, `Too many parameters for function: ${node.name}`, node.start);
		return false;
	} else if (node.params.length < required_param_count) {
		add_error(status, `Parameters missing for function: ${node.name}`, node.start);
		return false;
	}

	if (variadic_param_index >= 0) {
		const variadic_elem_type = func.params[variadic_param_index].type;
		// Variadic args begin at variadic_param_index - self_offset in the
		// call's param list (self is implicit, not passed by the caller).
		const variadic_start = variadic_param_index - self_offset;
		const variadic_args = node.params.splice(variadic_start, variadic_arg_count);
		const array_node = new ArrayValuesNode(variadic_args[0]?.start ?? 0, variadic_args);
		array_node.type = new Type(variadic_elem_type.name);
		array_node.type.is_array = true;
		node.params.splice(variadic_start, 0, array_node);
		node.variadic_param_name = func.params[variadic_param_index].name;
		(node as FunctionCallNode).variadic_param_index = variadic_start;
	}

	// Fill in defaults for trailing params the caller omitted. The call's
	// arg list (`node.params`) aligns with `func.params` MINUS the implicit
	// `self` slot, so both the bound and the index must skip `self` — otherwise
	// a method call that omits a defaulted param pushes one default too many
	// and the later per-arg pass indexes past the end of `func.params`.
	const non_self_param_count = func.params.length - self_offset;
	while (node.params.length < non_self_param_count) {
		const missing_param = func.params[node.params.length + self_offset];
		if (missing_param?.default_value) {
			node.params.push(missing_param.default_value);
		} else {
			break;
		}
	}

	status.stack.push(node);

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
		upper_bound_inclusive_exprs?: string[];
		lower_bound_inclusive_exprs?: string[];
		upper_bound_expr?: string;
		lower_bound_expr?: string;
		alias_of?: string;
	}[] = [];

	for (let [i, param] of node.params.entries()) {
		const func_param = func.params[i + self_offset];

		// Record which arguments correspond to a nullable struct value
		// parameter (`T? p`, T a non-class struct). The build backends use
		// this to emit a companion `_has` flag alongside the struct pointer
		// (see ROADBLOCKS "Nullable structs"). Self-params (`ref self` /
		// bare `self`) are skipped — the receiver is never a nullable value.
		if (
			func_param &&
			func_param.type.is_nullable &&
			!func_param.is_self_param &&
			!func_param.type.is_ref &&
			!func_param.type.is_array
		) {
			const s = status.structs.find(
				(st) => st.name === func_param.type.name && !st.is_class && !st.is_simple_type,
			);
			if (s) {
				if (!node.nullable_param_indices) node.nullable_param_indices = [];
				if (!node.nullable_param_indices.includes(i)) {
					node.nullable_param_indices.push(i);
				}
			}
		}

		// Set expected_type to the function parameter's type so that
		// untyped values (e.g. array literals) are inferred correctly,
		// rather than leaking the outer declaration's expected_type.
		const old_expected_type = status.expected_type;
		// Permit passing a nullable var — or the `null` literal — when the
		// parameter itself is nullable. Mirrors the save/restore pattern used
		// in check_operation_node for == / != / ??.
		const old_allow_null = status.allow_null_value;
		if (func_param) {
			status.expected_type = func_param.type;
			if (func_param.type.is_nullable) {
				status.allow_null_value = true;
			}
		}

		if (!check_node(param, status)) {
			status.expected_type = old_expected_type;
			status.allow_null_value = old_allow_null;
			continue;
		}
		status.expected_type = old_expected_type;
		status.allow_null_value = old_allow_null;

		// A `null` literal arg to a nullable struct VALUE parameter (`T? p`,
		// T a non-class struct) carries `Type("null")` from check_value_node,
		// which doesn't expose the param's struct name. The build backends
		// need that name to size the combined `[struct | flag]` storage they
		// materialise for a nullable-struct call site. Rewrite the arg's type
		// to the param's declared type so `get_struct_size` resolves
		// correctly. Narrow to non-class structs — nullable CLASS params
		// (`Box?`) have their own (pre-existing) call convention that doesn't
		// need this.
		if (
			func_param &&
			func_param.type.is_nullable &&
			!func_param.type.is_ref &&
			!func_param.type.is_array &&
			param.node_type === "value" &&
			(param as ValueNode).value === "null"
		) {
			const s = func_param.type.name
				? status.structs.find(
						(st) => st.name === func_param.type.name && !st.is_class && !st.is_simple_type,
					)
				: undefined;
			if (s) {
				(param as ValueNode).type = func_param.type;
			}
		}

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
		// A `ref` parameter receives a mutable borrow, so the argument must be
		// a mutable lvalue. A bare `const` variable is immutable and cannot be
		// borrowed mutably — passing one would let the callee silently mutate
		// the caller's supposedly-constant value. (`var` locals and existing
		// `ref`/borrow values are mutable; temporaries are non-`value` nodes
		// and are skipped here.)
		if (func_param.type.is_ref && has_ref_keyword && param.node_type === "value") {
			// The callee may mutate a `ref` argument, so the caller's binding is
			// not safely `const` — record it so the warning pass doesn't
			// recommend `const` for it.
			status.mutated_local_names?.add(param_value);
			const arg_decl = status.values.findLast((v) => v.name === param_value);
			if (arg_decl && arg_decl.declaration === "const" && !arg_decl.type.is_ref) {
				add_error(
					status,
					`Cannot pass const '${param_value}' to ref parameter '${func_param.name}' — declare it 'var' or pass a mutable value`,
					param.start,
				);
			}
		}
		// Only require explicit 'mov' keyword at the call site when the
		// parameter is a class type AND the argument is an OWNED variable
		// (has a name to invalidate). For temporaries (function call
		// results, literals), non-class types, and BORROW variables (which
		// cannot be moved soundly — see the shared-ownership check below),
		// mov is implicit, a no-op, or the borrow check below fires first.
		const param_is_class = func_param.type.name && is_class_type(func_param.type.name, status);
		const arg_is_variable = param.node_type === "value";
		const arg_is_owned_value = arg_is_variable && borrow_depth_of(param, status) === undefined;
		if (func_param.is_moved && !has_mov_keyword && param_is_class && arg_is_owned_value) {
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
		// Storing a BORROWED class/trait value into a `mov T` slot would
		// create shared ownership: the destination container's `#destroy`
		// (ClassBuffer-backed for class/trait element types) frees the
		// pointer per-element, but the borrow's source still references the
		// same instance — a runtime double-free (SIGABRT) when the source
		// is later destroyed. Reject at check time. The argument must be
		// an OWNED value: an owned local, a constructor call, or a
		// `mov out T` accessor result (e.g. `.pop()`, `Buffer.move_T(i)`).
		// `swap` is exempt — the swap expression replaces the source in
		// scope, so the move is sound even when the lvalue reads as a
		// borrow (e.g. `dst.push(mov src.field swap fresh)`).
		if (
			func_param.is_moved &&
			!node.swap_params?.has(i) &&
			func_param.type.name &&
			is_owning_ref_type(func_param.type.name, status)
		) {
			const arg_borrow_depth = borrow_depth_of(param, status);
			if (arg_borrow_depth !== undefined) {
				add_error(
					status,
					`Cannot move a borrowed value into owning parameter '${func_param.name}' — ` +
						`it would create shared ownership (the destination frees the pointer on destroy, ` +
						`leaving the borrow's source dangling). Pass an owned value: a fresh constructor, ` +
						`an owned local, or a 'mov out T' accessor result (e.g. .pop() or items.move_T(i)).`,
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
			// Stamp the caller's compile-time `length` onto the callee param so
			// field/constructor length knowledge propagates (e.g. `c.items`
			// after `Container(Array("a","b"))` → `c.items.length == 2`, which
			// discharges `.at(i)` bounds). This is safe for heap `Array<T>`
			// params too: the build's `array_struct_name` gate is now flag-based
			// (`is_array_heap`), not length-based, so the param still lowers to
			// `struct Array_<T>*`, and the for-of desugar uses the RUNTIME
			// `.length` bound for heap arrays (see desugar_array_for_loop).
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
		let upper_bound_inclusive_exprs: string[] | undefined;
		let lower_bound_inclusive_exprs: string[] | undefined;
		let upper_bound_expr: string | undefined;
		let lower_bound_expr: string | undefined;
		// Carry the argument's alias identity (e.g. `n` aliasing `list.length`),
		// so the constraint evaluator can prove `n - 1 < self.length` via the
		// alias-through-arithmetic path. Shifted by the constant for offset args.
		let alias_of: string | undefined;
		if (param.node_type === "value") {
			const decl = status.values.findLast((v) => v.name === (param as ValueNode).value);
			if (decl) {
				range_lower = decl.range_lower;
				range_upper = decl.range_upper;
				upper_bound_exprs = decl.upper_bound_exprs;
				lower_bound_exprs = decl.lower_bound_exprs;
				upper_bound_inclusive_exprs = decl.upper_bound_inclusive_exprs;
				lower_bound_inclusive_exprs = decl.lower_bound_inclusive_exprs;
				upper_bound_expr = decl.upper_bound_expr;
				lower_bound_expr = decl.lower_bound_expr;
				alias_of = decl.alias_of;
			}
		} else if (param.node_type === "op") {
			// Offset access like `arr.at(i - 1)` / `arr.at(i + 1)`: take the
			// base variable's proven bounds and shift them by the constant.
			const pop = param as OperationNode;
			if (pop.op === "+" || pop.op === "-") {
				let base_name: string | undefined;
				let c = 0;
				if (
					pop.left_value.node_type === "value" &&
					/^[+-]?\d+$/.test((pop.left_value as ValueNode).value)
				) {
					c = parseInt((pop.left_value as ValueNode).value, 10);
					if (pop.right_value.node_type === "value")
						base_name = (pop.right_value as ValueNode).value;
					if (pop.op === "-") c = -c;
				} else if (
					pop.right_value.node_type === "value" &&
					/^[+-]?\d+$/.test((pop.right_value as ValueNode).value)
				) {
					c = parseInt((pop.right_value as ValueNode).value, 10);
					if (pop.op === "-") c = -c;
					if (pop.left_value.node_type === "value") base_name = (pop.left_value as ValueNode).value;
				}
				if (base_name) {
					const decl = status.values.findLast((v) => v.name === base_name);
					if (decl) {
						const shift = (exprs?: string[]) => exprs?.map((e) => shift_offset_expr(e, c));
						range_lower = decl.range_lower !== undefined ? decl.range_lower + c : undefined;
						range_upper = decl.range_upper !== undefined ? decl.range_upper + c : undefined;
						upper_bound_exprs = shift(decl.upper_bound_exprs);
						lower_bound_exprs = shift(decl.lower_bound_exprs);
						upper_bound_inclusive_exprs = shift(decl.upper_bound_inclusive_exprs);
						lower_bound_inclusive_exprs = shift(decl.lower_bound_inclusive_exprs);
						upper_bound_expr = decl.upper_bound_expr
							? shift_offset_expr(decl.upper_bound_expr, c)
							: undefined;
						lower_bound_expr = decl.lower_bound_expr
							? shift_offset_expr(decl.lower_bound_expr, c)
							: undefined;
						alias_of = decl.alias_of ? shift_offset_expr(decl.alias_of, c) : undefined;
					}
				}
			}
		} else if (param.node_type === "access") {
			// A non-negative field/method access arg like `xs.length`,
			// `buf.cap`, `list.count()` is always >= 0, and an equality-style
			// constraint (`count <= self.length`) can match it directly. Carry
			// the access string as an alias so the constraint evaluator can
			// recognise the non-negativity through the parameter name (the
			// aliasing is also used by the alias-through-arithmetic path for
			// `end <= self.length` against `end.alias_of = "text.length"`).
			const access = param as AccessNode;
			let field_name: string | undefined;
			if (access.access.node_type === "access_field") {
				field_name = (access.access as AccessFieldNode).name;
			} else if (access.access.node_type === "access_func") {
				field_name = (access.access as { name: string }).name;
			}
			if (field_name && NON_NEGATIVE_FIELDS.has(field_name)) {
				alias_of = expr_to_string(param, status);
			}
		}
		// Fold in bounds propagated from a nested call's return contract, so a
		// parameter constraint can verify against an inline call result
		// (e.g. `g.at(g.edge_target(e))`). Method calls arrive as an AccessNode
		// wrapping an AccessFunctionCallNode; free calls arrive directly.
		let nested_rb:
			| {
					upper: string[];
					lower: string[];
					upper_inclusive: string[];
					lower_inclusive: string[];
			  }
			| undefined;
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
			upper_bound_inclusive_exprs = [
				...(upper_bound_inclusive_exprs ?? []),
				...nested_rb.upper_inclusive,
			];
			lower_bound_inclusive_exprs = [
				...(lower_bound_inclusive_exprs ?? []),
				...nested_rb.lower_inclusive,
			];
		}
		constraint_args.push({
			name: func_param.name,
			type: param_type,
			value: arg_value,
			range_lower,
			range_upper,
			upper_bound_exprs,
			lower_bound_exprs,
			upper_bound_inclusive_exprs,
			lower_bound_inclusive_exprs,
			upper_bound_expr,
			lower_bound_expr,
			alias_of,
		});

		// Evaluate constraints that reference this or earlier parameters
		// (skipped for array-destructuring `.at(i)` calls — the index is a
		// compile-time constant the programmer chose positionally).
		if (func_param.constraint && !(node as AccessFunctionCallNode).skip_bounds_check) {
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
					upper_bound_inclusive_exprs: ca.upper_bound_inclusive_exprs,
					lower_bound_inclusive_exprs: ca.lower_bound_inclusive_exprs,
					upper_bound_expr: ca.upper_bound_expr,
					lower_bound_expr: ca.lower_bound_expr,
					alias_of: ca.alias_of,
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

			const constraint_source = expression_to_source(func_param.constraint);
			const suffix = constraint_source ? `\n  ${constraint_source}` : "";

			if (satisfied === false) {
				add_error(
					status,
					`Parameter constraint not satisfied: ${func_param.name}${suffix}`,
					param.start,
				);
			} else if (satisfied === undefined) {
				// Constraint can't be verified at compile time (e.g. runtime variable index).
				// For ARRAY, STRING, and BUFFER index access, an unverifiable index is a
				// real out-of-bounds risk — the backends emit UNCHECKED strided loads
				// (`load_int`/`store_int`/`load`/`store`) — so we REQUIRE the caller
				// to prove the bound (e.g. a `while i < buf.cap` loop or `if i < buf.cap`
				// guard). `Buffer.cap` is a normal pub property, so the programmer can
				// hoist the guard outside the loop when the bound is loop-invariant.
				// Other unverifiable constraints (e.g. on a List/LinkedList/Graph `.at`
				// accessor whose bound references `self.count`) also error unless the
				// call is inside a trusted core library method.
				const inside_core = is_inside_core_method(status);
				if (!inside_core) {
					add_error(
						status,
						`Parameter constraint cannot be verified: ${func_param.name}${suffix}`,
						param.start,
					);
				}
			} else if (satisfied === "unsafe") {
				// The index is bounded by an INCLUSIVE upper bound that coincides
				// with the constraint's upper limit (e.g. `while i <= arr.length`
				// guarding `arr.at(i)`). That bound does NOT guarantee `i < length`,
				// so the access can read/write one element past the end. This is a
				// provable off-by-one, so reject it for every type (core or not).
				add_error(
					status,
					`Parameter constraint not satisfied: ${func_param.name}${suffix}`,
					param.start,
				);
			}
		}

		if (
			(param.node_type !== "value" ||
				is_heap_array_var_copy(param, func_param, param_type, status)) &&
			!has_ref_keyword &&
			!node.swap_params?.has(i) &&
			!(i === (node as FunctionCallNode).variadic_param_index && param.node_type === "array")
		) {
			const declaration_name = `_param_${status.var_name_counter.value++}`;
			// A value struct cannot be used through a trait type: trait-typed
			// parameters (and ClassBuffer<Trait> slots) hold heap-allocated,
			// vtable-bearing pointers, and the only way a value struct could
			// meet that was an implicit heap allocation ("boxing") at the call
			// site — the one place the language hid an allocation. Boxing is
			// gone now: declare the type as a `class` to use it polymorphically.
			// (Trait-typed *locals* with concrete struct storage still work —
			// they don't heap-allocate, so `var Speaker s = Dog()` is fine.)
			const param_is_trait = !!status.traits.find((t) => t.name === func_param.type.name);
			const arg_is_value_struct = !!status.structs.find(
				(s) => s.name === param_type.name && !s.is_class && !s.is_simple_type,
			);
			if (param_is_trait && arg_is_value_struct) {
				add_error(
					status,
					`value struct '${param_type.name}' cannot be used as trait '${func_param.type.name}'; declare '${param_type.name}' as a class`,
					param.start,
				);
			}
			const hoisted = new DeclarationNode(
				param.start,
				"private",
				"const",
				declaration_name,
				param_type,
				param,
			);
			// An array-literal or range-literal argument bound to a heap
			// `Array<T>` param (mono `Array_<T>` struct exists) must be
			// materialised as a HEAP array: the build promotes the param to
			// `struct Array_<T>*`, so the hoisted temp's stack array would
			// mismatch the expected struct pointer. Mark the temp and drop the
			// compile-time `length` from its type (the build recomputes the
			// element count from the literal's values / the range bounds). Raw
			// `T[]` params keep the stack-array temp.
			const param_is_heap_array = is_heap_array_type(func_param?.type);
			const arg_is_array_like = param.node_type === "array" || param.node_type === "range";
			// The marked temp is a heap `Array_<T>` at runtime; stamp
			// `is_array_heap` so the build recognises it deterministically (the
			// `array_struct_name` gate is now flag-based, not mono-existence).
			const heap_temp_type = (name: string): Type => {
				const t = new Type(name, undefined, true);
				t.is_array_heap = true;
				return t;
			};
			let hoisted_type = param_type;
			// Static literal/range args (compile-time `length`) bound to a heap
			// `Array<T>` param are marked for heap materialisation. Dynamic
			// (runtime-bound) ranges carry no compile-time length and stay on
			// the stack-array path.
			if (arg_is_array_like && param_is_heap_array && param_type.length) {
				hoisted.is_heap_array_literal = true;
				hoisted_type = heap_temp_type(param_type.name);
				hoisted.type = hoisted_type;
			}
			// A stack-array VARIABLE arg (`sum(v)` where `v` is a
			// `var Array<int> v = [2,4,6]` local, recognised by its compile-time
			// `length`) bound to a heap `Array<T>` param is copied into a heap
			// `Array_<T>` temp. The copy is a scoped declaration, so the buffer
			// is auto-freed; the caller's stack array is untouched (mutation of
			// a heap param only applies to `ref` params, which never take this
			// copy path).
			else if (param_is_heap_array && param_type.length) {
				hoisted.is_heap_array_copy = true;
				hoisted_type = heap_temp_type(param_type.name);
				hoisted.type = hoisted_type;
			}
			status.allocations.push(hoisted);
			node.params.splice(i, 1, new ValueNode(param.start, declaration_name, hoisted_type));
			// A temporary (e.g. a class constructor result) passed to a
			// signature-level `mov` param transfers ownership to the callee,
			// exactly like an explicit `mov var` argument. Record the index so
			// the build releases the hoisted temporary's anchor — otherwise the
			// instance is freed twice (once by the new owner, once by the
			// temporary's scope-exit cleanup).
			if (func_param?.is_moved) {
				if (!(node as FunctionCallNode).mov_param_indices)
					(node as FunctionCallNode).mov_param_indices = [];
				if (!(node as FunctionCallNode).mov_param_indices!.includes(i))
					(node as FunctionCallNode).mov_param_indices!.push(i);
			}
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
	// This lets subsequent `buf.store_int(0, …)` verify `0 < buf.cap`, and
	// also lets a hoisted `if i < buf.cap` guard discharge at compile time.
	// Covers void-style calls where the return value isn't captured. Resolve
	// the size argument through `numeric_interval` so that a `var` holding a
	// literal (e.g. `var int slot_count = 10; buf.alloc_int(slot_count)`)
	// propagates its numeric value — `const_value` is reserved for `const`
	// declarations, but a `var` initialized with a literal still gets a
	// point range `[n, n+1)` via `track_assignment_bounds`.
	// Match the generic `Buffer` (checked pre-mono on generic containers like
	// List<T>) as well as monomorphized names (Buffer_int, ClassBuffer_Animal)
	// seen on non-generic structs whose Buffer<T> fields are already rewritten.
	const is_bufferish =
		target_type?.name === "Buffer" ||
		!!target_type?.name?.startsWith("Buffer_") ||
		!!target_type?.name?.startsWith("ClassBuffer_");
	if (self_path && self_path !== "?" && is_bufferish && func.return_constraint) {
		const size_param = node.params[0];
		if (size_param) {
			const from_const = evaluate_numeric_or_bool(size_param, status);
			const size_val =
				typeof from_const === "number" ? from_const : numeric_interval(size_param, status)?.lower;
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

		// If the contract pins the result length to a literal (e.g.
		// `Array.with(elem, 5)` → `out.length == 5`), stash it so the array
		// method-call type transform can set the result type's `.length` for
		// the build's inline `to_string` paths. (Bounds checking is handled
		// separately via known_length; this is purely for codegen.)
		const ret_len = collect_return_length(substituted);
		if (ret_len !== undefined) node.inferred_array_length = ret_len;

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

/** Render a constraint expression AST back to a source-like string. */
function expression_to_source(node: BaseNode | null | undefined): string {
	if (!node) return "";
	if (node.node_type === "value") return (node as ValueNode).value;
	if (node.node_type === "access") {
		const access = node as AccessNode;
		const target = expression_to_source(access.target);
		if (access.access.node_type === "access_field") {
			const name = (access.access as AccessFieldNode).name;
			return target ? `${target}.${name}` : name;
		}
		if (access.access.node_type === "access_func") {
			const name = (access.access as { name: string }).name;
			return target ? `${target}.${name}()` : `${name}()`;
		}
		return target;
	}
	if (node.node_type === "op") {
		const op = node as OperationNode;
		return `${expression_to_source(op.left_value)} ${op.op} ${expression_to_source(op.right_value)}`;
	}
	return "";
}
