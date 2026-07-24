import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_function_call from "./check_function_call.ts";
import check_function_call_node, { monomorphize } from "./check_function_call_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { invalidate_borrows_of, receiver_owner_of } from "./utils/borrow.ts";
import { expr_to_string } from "./utils/flow_bounds.ts";
import {
	find_function_by_params,
	is_overloaded,
	mangled_label,
} from "./utils/function_overload.ts";
import is_sendable_type from "./utils/is_sendable_type.ts";
import is_visible from "./utils/is_visible.ts";
import { is_class_type } from "./utils/ownership.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_access_node(node: AccessNode, status: CheckStatus): boolean {
	if (!check_node(node.target, status)) {
		return false;
	}

	const target_type = type_from_value_node(node.target, status);
	if (!target_type.name) {
		add_error(status, `Unknown target: ${value_from_value_node(node.target)}`, node.target.start);
		return false;
	}

	// Resolve destructuring placeholders (`var [a, b] = expr`) from the RHS
	// type. A positional binding becomes a tuple field (`._i`), an array
	// element (direct index), or a struct/class field (`.name`). See
	// parse_destructuring.
	if (node.access.node_type === "access_field") {
		const af = node.access as AccessFieldNode;
		if (af.is_destructure) {
			const i = af.destructure_index!;
			if (target_type.is_array) {
				if (af.is_destructure_rename) {
					add_error(status, `Cannot rename elements when destructuring an array`, node.start);
					return false;
				}
				// Arrays may only be destructured when their length is known
				// at compile time (literals, constant ranges, Array.with, ...).
				const len_node = target_type.length;
				const known_len =
					len_node && len_node.node_type === "value"
						? parseInt((len_node as ValueNode).value, 10)
						: NaN;
				if (Number.isNaN(known_len)) {
					add_error(
						status,
						`Cannot destructure an array whose length is not known at compile time`,
						node.start,
					);
					return false;
				}
				if (i >= known_len) {
					add_error(
						status,
						`Cannot destructure index ${i} of an array with length ${known_len}`,
						node.start,
					);
					return false;
				}
				// Rewrite to `.at(i)` and dispatch as a method call. The index
				// is a compile-time constant within bounds (validated above), so
				// skip the `.at` parameter constraint (bounds) check.
				const idx = new ValueNode(node.start, String(i), new Type("int"));
				const fc = new AccessFunctionCallNode(node.start, "at", new Type(""), [idx]);
				fc.skip_bounds_check = true;
				node.access = fc;
				return check_access_function_node(target_type, node.target, fc, status);
			}
			// Struct/class or tuple: if the target has a field matching the
			// binding name, treat it as named field access; otherwise rewrite
			// to the tuple's positional `._i` field.
			const struct = status.structs.find((s) => s.name === target_type.name);
			const has_named_field = !!struct?.fields.find((f) => f.name === af.name);
			if (has_named_field) {
				af.is_destructure = undefined;
				// fall through to normal field access below
			} else if (struct) {
				if (af.is_destructure_rename) {
					add_error(status, `Field '${af.name}' not found on ${target_type.name}`, node.start);
					return false;
				}
				// Tuple positional destructure: validate the index against the
				// tuple's arity (the auto-generated fields `_0`..`_(N-1)`).
				if (struct.name.startsWith("_Tuple_") && i >= struct.fields.length) {
					add_error(
						status,
						`Cannot destructure index ${i} of a tuple with ${struct.fields.length} elements`,
						node.start,
					);
					return false;
				}
				af.name = `_${i}`;
				af.is_destructure = undefined;
				// fall through to normal field access below
			} else {
				add_error(status, `Cannot destructure value of type ${target_type.name}`, node.start);
				return false;
			}
		}
	}

	// Check that class-type variables are initialized before field/method access
	if (
		node.target.node_type === "value" &&
		target_type.name &&
		is_class_type(target_type.name, status)
	) {
		const var_name = (node.target as import("../nodes/ValueNode.ts").default).value;
		const decl = status.values.findLast((v) => v.name === var_name);
		if (decl && decl.is_set === false && !status.allow_null_value) {
			add_error(status, `Variable '${var_name}' is not initialized`, node.target.start);
			return false;
		}
	}

	switch (node.access.node_type) {
		case "access_field": {
			return check_access_field_node(target_type, node.access as AccessFieldNode, status);
		}
		case "access_func": {
			return check_access_function_node(
				target_type,
				node.target,
				node.access as AccessFunctionCallNode,
				status,
			);
		}
	}

	return true;
}

function check_access_field_node(
	target_type: Type,
	node: AccessFieldNode,
	status: CheckStatus,
): boolean {
	let struct = status.structs.find((s) => s.name === target_type.name);
	if (struct?.is_generic && target_type.type_args?.length) {
		const mono_name = target_type.name + "_" + target_type.type_args.map((t) => t.name).join("_");
		struct = status.structs.find((s) => s.name === mono_name) || struct;
	}
	let field = struct?.fields.find((f) => f.name === node.name);
	if (!field) {
		// Are we accessing a field in a trait?
		const trait = status.traits.find((s) => s.name === target_type.name);
		if (trait) {
			field = trait?.fields.find((f) => f.name === node.name);
		}
	}
	if (!field) {
		// Are we accessing a field in a struct with a trait and a default value?
		const struct = status.structs.find((s) => s.name === target_type.name);
		if (struct) {
			for (let trait_name of struct.traits) {
				const trait = status.traits.find((s) => s.name === trait_name);
				if (trait) {
					field = trait.fields.find((f) => f.name === node.name && f.value);
					if (field) break;
				}
			}
		}
	}
	// HACK:
	if (!field) {
		// Are we accessing an enum case?
		const enum_node = status.enums.find((e) => e.name === target_type.name);
		if (enum_node) {
			const enum_case = enum_node.cases.find((c) => c.name === node.name);
			if (enum_case) {
				node.type = new Type(target_type.name);
				return true;
			} else {
				if (enum_node.has_associated_data) {
					for (const c of enum_node.cases) {
						const param = c.params.find((p) => p.name === node.name);
						if (param) {
							node.type = param.type;
							return true;
						}
					}
				}
				add_error(status, `Unknown enum case: ${target_type.name}.${node.name}`, node.start);
				return false;
			}
		}
	}
	if (!field) {
		// Are we accessing a bitset case?
		const bitset_node = status.bitsets.find((b) => b.name === target_type.name);
		if (bitset_node) {
			if (bitset_node.cases.includes(node.name)) {
				node.type = new Type(target_type.name);
				return true;
			} else {
				add_error(status, `Unknown bitset case: ${target_type.name}.${node.name}`, node.start);
				return false;
			}
		}
	}
	if (!field) {
		// Are we accessing length in an array
		if (target_type.is_array && node.name === "length") {
			node.type = new Type("int");
			return true;
		}
		// Are we accessing length on a string (computed property → strlen)
		if (target_type.name === "string" && node.name === "length") {
			node.type = new Type("int");
			return true;
		}
		// view string.length → the slice's stored length (no strlen, no field)
		if (target_type.is_view && target_type.name === "string" && node.name === "length") {
			node.type = new Type("int");
			return true;
		}
	}
	if (!field) {
		const struct = status.structs.find((s) => s.name === target_type.name);
		const func = struct?.functions.find((f) => f.name === node.name);
		if (func) {
			const func_type = new Type("func");
			func_type.func_params = func.params;
			func_type.func_return_type = func.return_type;
			node.type = func_type;
			return true;
		}
	}
	if (!field) {
		const enum_node = status.enums.find((e) => e.name === target_type.name);
		if (enum_node && enum_node.has_associated_data) {
			for (const c of enum_node.cases) {
				const param = c.params.find((p) => p.name === node.name);
				if (param) {
					node.type = param.type;
					return true;
				}
			}
		}
	}
	if (field) {
		const access_scope = status.stack.at(-1)!;
		if (
			field.visibility === "private" &&
			!is_visible(field.scope, field.visibility, access_scope, status.stack)
		) {
			add_error(status, `Can't access private field: ${node.name}`, node.start);
			return false;
		} else {
			node.type = field.type;
		}
	} else {
		add_error(status, `Field not found: ${node.name}`, node.start);
		return false;
	}

	return true;
}

function check_access_function_node(
	target_type: Type,
	target: BaseNode,
	node: AccessFunctionCallNode,
	status: CheckStatus,
): boolean {
	// Escape hatch: `nursery.spawn(fn, args...)` spawns `fn(args...)` into the
	// nursery referenced by the receiver. The first param is the function name;
	// the rest are its arguments. See ASYNC.md, "Escape hatch: passing the
	// nursery". Special-cased (rather than a real method on Nursery) because the
	// spawn needs the per-site trampoline machinery.
	if (target_type.name === "Nursery" && node.name === "spawn") {
		return check_nursery_spawn(node, status);
	}

	// `view string` builtins: .at and .to_string are compiler intrinsics that
	// operate on the (ptr, len) slice directly. They must NOT resolve to the
	// `string` struct's methods (whose #arch bodies expect a `char*` self).
	if (target_type.is_view && target_type.name === "string") {
		if (node.name === "at") {
			for (const param of node.params) {
				check_node(param, status);
			}
			node.type = new Type("char");
			return true;
		}
		if (node.name === "to_string") {
			node.type = new Type("string");
			return true;
		}
	}

	// For array types, route method calls to the Array struct
	let effective_type = target_type;
	if (target_type.is_array) {
		const array_struct = status.structs.find((s) => s.name === "Array");
		if (array_struct) {
			// Monomorphize for the element type if generic
			if (array_struct.type_params.length > 0) {
				const elem_type = new Type(target_type.name);
				const mono = monomorphize(array_struct, [elem_type], status);
				if (mono) {
					effective_type = new Type(mono.name);
				}
			}
		}
	} else if (target_type.name === "Array" && target.node_type === "value") {
		// Static method call on Array (e.g. Array<int>.with(0, 3) or Array.with(0, 3))
		const array_struct = status.structs.find((s) => s.name === "Array");
		if (array_struct && array_struct.type_params.length > 0) {
			const type_args = (target as ValueNode).type_args;
			if (type_args?.length) {
				// Explicit type args: Array<int>.with(0, 3)
				const mono = monomorphize(array_struct, type_args, status);
				if (mono) {
					effective_type = new Type(mono.name);
				}
			} else if (node.params.length > 0 && node.name === "with") {
				// No type args but calling with(): infer T from first arg
				const arg_type = type_from_value_node(node.params[0], status);
				if (arg_type.name && !arg_type.is_array) {
					const mono = monomorphize(array_struct, [arg_type], status);
					if (mono) {
						effective_type = new Type(mono.name);
					}
				}
			}
		}
	}

	// Resolve generic type to monomorphized name so we find the right methods
	if (effective_type.type_args?.length && !effective_type.is_array) {
		const mono_name =
			effective_type.name + "_" + effective_type.type_args.map((t) => t.name).join("_");
		if (status.structs.find((s) => s.name === mono_name)) {
			effective_type = new Type(mono_name);
		}
	}

	const struct = status.structs.find((s) => s.name === effective_type.name);

	let func: FunctionNode | undefined;
	if (struct) {
		const arg_types = node.params.map((p) => type_from_value_node(p, status));
		func = find_function_by_params(struct.functions, node.name, arg_types);
	}

	if (!func) {
		func = struct?.functions.findLast((f) => f.name === node.name);
	}
	if (!func && (node.name === "destroy" || node.name === "init")) {
		func = struct?.functions.findLast((f) => f.name === `#${node.name}`);
	}

	if (!func) {
		// Are we accessing a func in a trait?
		const trait = status.traits.find((s) => s.name === target_type.name);
		if (trait) {
			func = trait.functions.find((f) => f.name === node.name);
		}
	}

	if (!func) {
		// Are we accessing a func in a struct with a trait and a default value?
		const struct = status.structs.find((s) => s.name === target_type.name);
		if (struct) {
			for (let trait_name of struct.traits) {
				const trait = status.traits.find((s) => s.name === trait_name);
				if (trait) {
					func = trait.functions.find((f) => f.name === node.name && f.has_body);
					if (func) break;
				}
			}
		}
	}

	if (!func) {
		// Are we calling an enum case constructor?
		const enum_node = status.enums.find((e) => e.name === target_type.name);
		if (enum_node) {
			const enum_case = enum_node.cases.find((c) => c.name === node.name);
			if (enum_case) {
				node.type = new Type(target_type.name);
				node.is_static = true;

				for (let param of node.params) {
					check_node(param, status);
				}

				return true;
			}
		}
	}

	// Make sure the function exists
	if (!func) {
		// For enum/bitset types, delegate to_string to int
		if (
			node.name === "to_string" &&
			(status.enums.find((e) => e.name === target_type.name) ||
				status.bitsets.find((b) => b.name === target_type.name))
		) {
			const int_struct = status.structs.find((s) => s.name === "int");
			func = int_struct?.functions.find((f) => f.name === "to_string");
		}
	}
	if (!func) {
		add_error(status, `Function not found: ${target_type.name}.${node.name}`, node.start);
		return false;
	}

	if (struct && is_overloaded(struct, node.name)) {
		node.mangled_name = mangled_label(func, struct.name);
	}

	// A `mov out T` method transfers ownership of its result to the caller
	// (it's an owned value, not a borrow). Record that on the node so the
	// borrow checker treats it as non-borrowed and the build anchors it.
	if (func.returns_mov) {
		node.owned_return = true;
	}

	// Check for calling a mutating method on a const variable
	// (detected by `ref self` on the first parameter)
	if (func.params[0]?.is_self_param && (func.params[0].is_ref || func.params[0].type?.is_ref)) {
		// A mutating call may free or displace the receiver's contents, so every
		// live child-group borrow rooted at this receiver is now stale. Resolve
		// the ultimate owner so field-path receivers (e.g. z.animals.push) and
		// borrows-of-borrows are invalidated transitively.
		const owner = receiver_owner_of(target, status);
		if (target.node_type === "value") {
			const target_name = (target as ValueNode).value;
			// Skip 'self' — ref self methods can be called on self within other ref self methods
			if (target_name !== "self") {
				const decl = status.values.findLast((v) => v.name === target_name);
				if (decl?.declaration === "const" && !decl?.type?.is_ref) {
					add_error(status, `Update to const: ${target_name}`, node.start);
					return false;
				}
			}
		}
		if (owner) {
			invalidate_borrows_of(status, owner);
		}
	}

	// Forward-reference fix: a non-generic struct method with an *inferred*
	// return type gets that type only when its body is checked. If the struct
	// is defined textually after this call (always true for library structs,
	// whose source is appended after user code), the body hasn't been checked
	// yet and the return type is unknown. Infer it now by checking just the
	// body in a throwaway cloned status -- this only sets func.return_type on
	// the node; it does not mark the function checked or otherwise disturb the
	// main check/build flow (generic structs are handled by monomorphization).
	if (
		struct &&
		struct.type_params.length === 0 &&
		func &&
		!func.return_type.name &&
		returns_value(func)
	) {
		infer_return_type(func, status);
	}

	const result = check_function_call(
		node,
		status,
		func,
		target_type,
		value_from_value_node(target),
		expr_to_string(target, status),
	);

	// Convert Array struct return type back to array type for array method calls.
	// Also carry a literal length derived from the call's return contract
	// (`out Array<T>: out.length == N`) onto the result type, so the build's
	// inline to_string/n paths fire (they unroll a literal element count and
	// only engage when the array type has a known `.length`).
	if (result && node.type) {
		const return_is_array_struct =
			node.type.name === "Array" || node.type.name?.startsWith("Array_");
		const return_is_array_type = node.type.is_array;
		if (return_is_array_struct || return_is_array_type) {
			if (return_is_array_struct) {
				// Determine element type: from target array, from explicit type_args, from mono name, or from return type_args
				const elem_name = target_type.is_array
					? target_type.name
					: target.node_type === "value" && (target as ValueNode).type_args?.length
						? (target as ValueNode).type_args![0].name
						: node.type.name.startsWith("Array_")
							? node.type.name.slice(6)
							: node.type.type_args?.length
								? node.type.type_args[0].name
								: "";
				if (elem_name) {
					node.type = new Type(elem_name);
					node.type.is_array = true;
				}
			} else if (node.inferred_array_length) {
				// Already in internal array form (e.g. Type("char", is_array=true)).
				// Clone so we don't mutate the shared monomorphized return_type.
				const t = node.type;
				node.type = new Type(t.name, t.is_static, t.is_array, t.length);
				node.type.is_ref = t.is_ref;
				node.type.type_args = t.type_args;
			}
			if (node.inferred_array_length && node.type.is_array) {
				node.type.length = new ValueNode(-1, node.inferred_array_length, new Type("int"));
			}
		}
	}

	return result;
}

// Infer a function's return type by scanning its body for return statements
// and resolving the return value's type directly from the AST. This avoids
// calling check_block_node / check_function_call which mutate shared AST nodes
// (e.g. replacing params with _param_N ValueNodes), causing "Unknown value"
// errors when the main check later processes the same body.
function infer_return_type(func: FunctionNode, status: CheckStatus) {
	// Collect local variable types from the body so we can resolve return
	// expressions that reference locals (e.g. `return idx` where idx was
	// declared as `var int idx = ...` earlier in the body).
	const locals = collect_local_vars(func);
	for (const child of func.statements) {
		const rt = resolve_return_type_from_node(child, func, locals, status);
		if (rt) {
			func.return_type = rt;
			return;
		}
	}
}

function collect_local_vars(func: FunctionNode): Map<string, Type> {
	const locals = new Map<string, Type>();
	for (const child of func.statements) {
		collect_vars_from_node(child, locals);
	}
	return locals;
}

function collect_vars_from_node(node: BaseNode, locals: Map<string, Type>) {
	if (node.node_type === "declare") {
		const decl = node as DeclarationNode;
		if (decl.type?.name) {
			locals.set(decl.name, decl.type);
		}
	}
	for (const val of Object.values(node)) {
		if (Array.isArray(val)) {
			for (const item of val) {
				if (item && typeof item === "object" && "node_type" in item) {
					collect_vars_from_node(item as BaseNode, locals);
				}
			}
		} else if (val && typeof val === "object" && "node_type" in val) {
			collect_vars_from_node(val as BaseNode, locals);
		}
	}
}

function resolve_return_type_from_node(
	node: BaseNode,
	func: FunctionNode,
	locals: Map<string, Type>,
	status: CheckStatus,
): Type | null {
	if (node.node_type === "return") {
		const ret = node as { value?: BaseNode };
		if (ret.value) {
			return resolve_type_from_expr(ret.value, func, status, locals);
		}
		return null;
	}
	// Recurse into child nodes that might contain return statements
	for (const val of Object.values(node)) {
		if (Array.isArray(val)) {
			for (const item of val) {
				if (item && typeof item === "object" && "node_type" in item) {
					const rt = resolve_return_type_from_node(item as BaseNode, func, locals, status);
					if (rt) return rt;
				}
			}
		} else if (val && typeof val === "object" && "node_type" in val) {
			const rt = resolve_return_type_from_node(val as BaseNode, func, locals, status);
			if (rt) return rt;
		}
	}
	return null;
}

function resolve_type_from_expr(
	node: BaseNode,
	func: FunctionNode,
	status: CheckStatus,
	locals?: Map<string, Type>,
): Type | null {
	if (node.node_type === "value") {
		const val = node as ValueNode;
		// Look up in function params
		for (const param of func.params ?? []) {
			if (param.name === val.value) {
				return param.type;
			}
		}
		// Look up in local variables
		if (locals?.has(val.value)) {
			return locals.get(val.value)!;
		}
		// Look up in local values
		const decl = status.values.findLast((v) => v.name === val.value);
		if (decl) return decl.type;
	}
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const target_type = resolve_type_from_expr(access.target, func, status, locals);
			if (target_type?.name) {
				const struct = status.structs.find((s) => s.name === target_type.name);
				const field = struct?.fields.find(
					(f) => f.name === (access.access as AccessFieldNode).name,
				);
				if (field) return field.type;
			}
		}
	}
	return null;
}

// Whether a function body contains a `return <value>` statement (i.e. it has
// an inferred return type to discover). Bare `return` / void functions have no
// return type to infer, so we leave them alone. A visited set guards against
// back-references (e.g. a node's `scope` pointing to the owning struct, which
// in turn holds this function).
function returns_value(node: BaseNode, visited: Set<BaseNode> = new Set()): boolean {
	if (visited.has(node)) {
		return false;
	}
	visited.add(node);
	if (node.node_type === "return") {
		return !!(node as { value?: BaseNode }).value;
	}
	for (const val of Object.values(node)) {
		if (Array.isArray(val)) {
			for (const item of val) {
				if (
					item &&
					typeof item === "object" &&
					"node_type" in item &&
					returns_value(item as BaseNode, visited)
				) {
					return true;
				}
			}
		} else if (val && typeof val === "object" && "node_type" in val) {
			if (returns_value(val as BaseNode, visited)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Check a `nursery.spawn(fn, args...)` escape-hatch call. The first parameter
 * names the function to spawn; the remaining parameters are its arguments.
 * Reuses check_function_call_node by building a synthetic call, then enforces
 * Sendable on every argument and types the expression as `Task<T>` (mirroring
 * check_spawn_node). See ASYNC.md.
 */
/**
 * Check a `name.spawn(fn(args))` escape-hatch call. The single parameter is the
 * call expression to spawn (same shape as bare `spawn fn(args)`); checking it
 * via check_function_call_node resolves the function, matches argument types,
 * and computes the return type. Enforces Sendable on every argument and types
 * the expression as `Task<T>` (mirroring check_spawn_node). See ASYNC.md.
 */
function check_nursery_spawn(node: AccessFunctionCallNode, status: CheckStatus): boolean {
	if (node.params.length !== 1 || node.params[0].node_type !== "func_call") {
		add_error(
			status,
			"nursery.spawn expects a single call expression, e.g. .spawn(work(n))",
			node.start,
		);
		return false;
	}
	const call = node.params[0] as FunctionCallNode;

	const ok = check_function_call_node(call, status);
	if (!ok) {
		add_error(status, `Spawned call '${call.name}' did not resolve`, node.start);
		return false;
	}

	// Every argument moved into the spawned task must be Sendable.
	for (const param of call.params) {
		const arg_type = type_from_value_node(param, status);
		if (!is_sendable_type(arg_type.name, status)) {
			add_error(
				status,
				`Spawn argument of type ${arg_type.name || "<unknown>"} is not Sendable`,
				param.start,
			);
		}
	}

	// Type the expression as Task<T> where T is the spawned function's return
	// type (uint64 for void functions — the result slot exists but is unused).
	const return_type = call.type;
	const result_type_arg =
		return_type && return_type.name && return_type.name !== "void" && return_type.name !== "?"
			? new Type(return_type.name)
			: new Type("uint64");
	const task_type = new Type("Task");
	task_type.type_args = [result_type_arg];
	node.function_return_type = return_type;
	node.type = task_type;
	node.is_nursery_spawn = true;
	// The Task a nursery.spawn yields is a fresh heap allocation (not a borrow),
	// so a capturing declaration owns and must free it. Without this, the
	// declaration would be treated as a class alias and leak.
	node.owned_return = true;

	// Trigger monomorphization of Task<T> so the struct body is emitted.
	const task_struct = status.structs.find((s) => s.name === "Task");
	if (task_struct && task_struct.type_params.length > 0) {
		monomorphize(task_struct, [result_type_arg], status);
	}

	return true;
}
