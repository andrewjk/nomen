import { mono_type_name } from "../build_common/mono_name.ts";
import {
	drop_self_written_string_field_records,
	scan_self_string_field_writes,
} from "../build_common/scan_self_string_writes.ts";
import { is_view_value } from "../build_common/view_value.ts";
import { is_built_in_type } from "../built_in_types.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import build_nursery_spawn from "./build_nursery_spawn.ts";
import { is_owned_heap_temp } from "./build_operation_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import { find_decl_in_c_scopes } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import {
	closure_dispose_arm,
	c_return_type,
	materialize_func_value,
	next_lambda_arg_temp,
	next_lambda_ret_temp,
} from "./utils/closure.ts";
import { begin_code_scratch, end_code_scratch } from "./utils/code_scratch.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import { c_view_string_arg } from "./utils/view_value.ts";

/**
 * The C type of a single element of a `view T` slice, used to cast the
 * universal `nomen_view.ptr` for `.at`/`.set`. `view string`'s element is a
 * `char`; every other view's element is its own type name.
 */
function view_element_c_type(view_type: Type, status: BuildStatus): string {
	const elem_name = view_type.name === "string" ? "char" : view_type.name;
	const is_struct = !!status.structs.find((s) => s.name === elem_name && !s.is_simple_type);
	if (is_struct) return `struct ${elem_name}`;
	return c_type(elem_name);
}

/**
 * A call through a func-typed struct FIELD (`s.f(args)`): the field is a
 * `void *` slot holding a closure descriptor (CLOSURE.md) —
 * load { code, env } and call with the env first:
 * `((<ret> (*)(void *, <params>))((struct nomen_closure *)<field>)->code)
 *    (((struct nomen_closure *)<field>)->env, <args>)`.
 */
function build_func_field_call(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
): void {
	const target_type = type_from_value_node(node.target);
	const struct = status.structs.find((s) => s.name === target_type.name);
	const field = struct?.fields.find((f) => f.name === access_func.name);
	if (!field || !field.func_params) {
		// The checker only marks real func fields; fall back to a plain
		// field read so we never emit nothing.
		build_node(node.target, status);
		return;
	}
	const ret = c_type(field.func_return_type?.name || "void");
	// An INLINE capturing lambda argument to the func-typed parameter is a
	// one-shot heap descriptor the callee only borrows (CLOSURE.md) —
	// capture each into a wrapper-declared temp at its argument position
	// and reclaim once the call returns. (The func_field_call arg loop is
	// a plain value build — no type-based routing to interference.)
	const lambda_arg_temps = new Map<number, string>();
	for (let i = 0; i < access_func.params.length; i++) {
		const p = access_func.params[i];
		if (p.node_type !== "func") continue;
		if (!(p as FunctionNode).captures?.length) continue;
		const fp = field.func_params[i];
		if (!fp || !(fp.func_params || fp.func_return_type)) continue;
		lambda_arg_temps.set(i, next_lambda_arg_temp());
	}
	if (lambda_arg_temps.size > 0) {
		status.code += `({ `;
		for (const tmp of lambda_arg_temps.values()) {
			status.code += `struct nomen_closure *${tmp}; `;
		}
	}
	const lambda_ret_tmp =
		lambda_arg_temps.size > 0 && ret !== "void" ? next_lambda_ret_temp() : undefined;
	if (lambda_ret_tmp) {
		status.code += `${ret} ${lambda_ret_tmp} = `;
	}
	// The field access `receiver.field` — reuse the ordinary access path so
	// `.`/`->` and ref receivers are handled uniformly. Built twice (code
	// and env reads); both loads of the same descriptor slot.
	const field_access = new AccessNode(
		node.start,
		node.target,
		new AccessFieldNode(node.start, access_func.name, field.type),
	);
	const capture = (fn: () => void): string => {
		const saved = status.code;
		status.code = "";
		fn();
		const out = status.code;
		status.code = saved;
		return out;
	};
	const desc_code = capture(() => {
		status.code += `((struct nomen_closure *)`;
		build_node(field_access, status);
		status.code += `)->code`;
	});
	const desc_env = capture(() => {
		status.code += `((struct nomen_closure *)`;
		build_node(field_access, status);
		status.code += `)->env`;
	});
	status.code += `((${ret} (*)(void *`;
	for (let i = 0; i < field.func_params.length; i++) {
		status.code += ", ";
		build_parameter_node(field.func_params[i], status);
	}
	status.code += `))${desc_code})(${desc_env}`;
	for (let i = 0; i < access_func.params.length; i++) {
		status.code += ", ";
		const lambda_tmp = lambda_arg_temps.get(i);
		if (lambda_tmp) status.code += `(${lambda_tmp} = `;
		build_node(access_func.params[i], status);
		if (lambda_tmp) status.code += `)`;
	}
	status.code += `)`;
	if (lambda_arg_temps.size > 0) {
		for (const tmp of lambda_arg_temps.values()) {
			status.code += `; ${closure_dispose_arm(tmp)}`;
		}
		if (lambda_ret_tmp) status.code += `; ${lambda_ret_tmp}`;
		status.code += `; })`;
	}
}

/**
 * Compute a C expression that yields a `struct Nursery *` for the receiver of
 * a `name.spawn(...)` escape-hatch call. A `ref Nursery` parameter is already a
 * pointer; any other Nursery lvalue (the async block's named local, etc.)
 * needs its address taken.
 */
function nursery_pointer_expr(target: BaseNode, status: BuildStatus): string {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		// ref Nursery param — emitted as `struct Nursery *name`.
		if (status.function_ref_params?.has(name)) return name;
	}
	// Any other Nursery lvalue: build it and take its address.
	const saved = begin_code_scratch(status);
	status.suppress_dereference = true;
	build_node(target, status);
	status.suppress_dereference = false;
	const expr = end_code_scratch(status, saved);
	return "&" + expr;
}

/**
 * Build a node for use as a vtable dispatch target. The vtable lives at offset
 * 0 of the struct (`_vt`), so `_get_trait_func` needs a POINTER to the struct
 * (not the by-value struct). When the target is the implicit `self` parameter,
 * the build normally renames it to `_self` (the local by-value copy made at
 * function entry) — but for vtable dispatch we need the original `self` pointer
 * param, so emit it directly. A ref/trait/class param is already a pointer; any
 * other lvalue (local variable) gets its address taken. `&*x` is valid C and
 * simplifies to `x`, so a ref param that slipped through still lands on its
 * pointer.
 */
export function build_vtable_target(node: BaseNode, status: BuildStatus) {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		if (name === "self") {
			status.code += "self";
			return;
		}
		// A CAPTURED trait/class receiver lives in the closure env as a
		// pointer (`_env->name`); emit it directly — taking its address would
		// pass the env slot, not the instance (CLOSURE.md Phase 2c).
		const captured_shadowed =
			!!status.current_function?.params.some((p) => p.name === name) ||
			!!find_decl_in_c_scopes(status, name);
		if (!captured_shadowed && status.closure_env?.has(name)) {
			status.code += status.closure_env.get(name)!;
			return;
		}
		// ref/trait/class param — emitted as `struct T *name`, already a pointer.
		if (status.function_ref_params?.has(name) || status.class_vars?.has(name)) {
			status.code += c_function_name(name);
			return;
		}
	}
	// A class-typed RECEIVER EXPRESSION (a container element access like
	// `rules.at(i)`, or any expression whose static type is a class) already
	// evaluates to the instance pointer — vtable dispatch wants that pointer,
	// not its address. `&expr` would be `&` of an rvalue (clang: "cannot take
	// the address of an rvalue"). Bare locals are handled above; an inline
	// value-struct-backed trait slot still takes its address below.
	if (node.node_type !== "value") {
		const expr_type = type_from_value_node(node);
		const expr_is_class =
			!!expr_type?.name && !!status.structs.find((s) => s.name === expr_type.name && s.is_class);
		if (expr_is_class) {
			status.suppress_dereference = true;
			build_node(node, status);
			status.suppress_dereference = false;
			return;
		}
	}
	// Any other lvalue: build it without the ref-param deref and take its address.
	const saved = begin_code_scratch(status);
	status.suppress_dereference = true;
	build_node(node, status);
	status.suppress_dereference = false;
	const expr = end_code_scratch(status, saved);
	status.code += "&" + expr;
}

/**
 * An Array method's `self` is a `struct Array_<T>*` — header `[0]=_vt`,
 * `[8]=length`, elements at `+16` — which is exactly what a heap receiver
 * (`struct Array_<T>*`) already is. A NON-heap receiver (a plain stack C
 * array `T w[N]`, or a variadic `...T` param lowered to `T *w`) would pass
 * the bare element pointer, so the callee's `self->length` and the raw
 * bodies' `(T*)((char*)self + sizeof(*self))` reads land on garbage
 * (`w[1]`, `w + 2`). When such a receiver with a usable length calls a
 * method on the mono `Array_<T>` struct, build a statement-expression
 * temporary carrying a proper header plus a copy of the elements — the
 * same wrap the binary-operator operand path uses
 * (build_array_operand_for_call). A `ref self` callee additionally gets
 * its element copy written back after the call, so mutations through
 * `self` reach the caller's array.
 */
function array_receiver_wrap(
	node: AccessNode,
	target_type: Type | undefined,
	target_method: FunctionNode | undefined,
	mono_struct_name: string,
	status: BuildStatus,
): { prefix: string; self_expr: string; suffix: string } | undefined {
	if (!target_type?.is_array || !mono_struct_name.startsWith("Array_")) return undefined;
	if (node.target.node_type !== "value") return undefined;
	const target_value = (node.target as ValueNode).value;
	if (target_type.is_array_heap || status.heap_array_vars?.has(target_value)) return undefined;
	// Element-count expression: the auto_free registration for owning
	// stack arrays, the checker's stamped compile-time length, or a
	// variadic param's hidden `_<name>_len`. Without one there is no sound
	// wrap (e.g. a `T[]` param's runtime length), so leave the receiver
	// untouched.
	let length: string | undefined;
	if (status.stack_array_lengths?.has(target_value)) {
		length = status.stack_array_lengths.get(target_value);
	} else if (target_type.length) {
		const saved = begin_code_scratch(status);
		build_node(target_type.length, status);
		length = end_code_scratch(status, saved);
	} else if (status.function_variadic_params?.has(target_value)) {
		length = `_${target_value}_len`;
	}
	if (!length) return undefined;
	// Capture the receiver's C lvalue text (the bare array identifier).
	const saved = begin_code_scratch(status);
	status.suppress_dereference = true;
	build_node(node.target, status);
	status.suppress_dereference = false;
	const recv = end_code_scratch(status, saved);

	const elem_c = c_type(target_type.name);
	const id = (status.label_counter = (status.label_counter ?? 0) + 1);
	const wrap = `_arrm_${id}`;
	const method_self_is_ref = !!target_method?.params?.some(
		(p) => p.is_self_param && (p.is_ref || p.type?.is_ref),
	);
	const ret = target_method?.return_type;
	const ret_c = !ret?.name ? "void" : ret.is_array ? "void*" : c_type(ret.name);
	const bytes = `${length} * sizeof(${elem_c})`;
	// A compile-time length sizes the wrap struct's inline `_d[N]` member
	// directly. A runtime length (a variadic receiver's `_<name>_len`) can't
	// — VLAs are illegal in struct members — so use a flat VLA byte buffer
	// with the 16-byte header at its start and the elements memcpy'd to +16
	// (exactly where `sizeof(struct Array_<T>)`-based reads expect them).
	const length_is_literal = /^(\d+L?|0x[0-9a-fA-F]+)$/.test(length.trim());
	let prefix: string;
	let self_expr: string;
	if (length_is_literal) {
		prefix =
			`({ struct { struct ${mono_struct_name} _h; ${elem_c} _d[${length}]; } ${wrap}; ` +
			`${wrap}._h._vt = 0; ${wrap}._h.length = ${length}; ` +
			`memcpy(${wrap}._d, ${recv}, ${bytes}); ` +
			(method_self_is_ref && ret_c !== "void" ? `${ret_c} _arrm_r_${id} = ` : "");
		self_expr = `(struct ${mono_struct_name}*)&${wrap}`;
	} else {
		prefix =
			`({ char ${wrap}[sizeof(struct ${mono_struct_name}) + ${bytes}]; ` +
			`struct ${mono_struct_name}* _arrm_p_${id} = (struct ${mono_struct_name}*)${wrap}; ` +
			`_arrm_p_${id}->_vt = 0; _arrm_p_${id}->length = ${length}; ` +
			`memcpy(${wrap} + sizeof(struct ${mono_struct_name}), ${recv}, ${bytes}); ` +
			(method_self_is_ref && ret_c !== "void" ? `${ret_c} _arrm_r_${id} = ` : "");
		self_expr = `_arrm_p_${id}`;
	}
	const copy_back = `memcpy(${recv}, ${
		length_is_literal ? `${wrap}._d` : `${wrap} + sizeof(struct ${mono_struct_name})`
	}, ${bytes}); `;
	const suffix =
		(method_self_is_ref
			? `; ${copy_back}` + (ret_c !== "void" ? `_arrm_r_${id}; ` : `(void)0; `)
			: "") + `; })`;
	return { prefix, self_expr, suffix };
}

export default function build_access_node(node: AccessNode, status: BuildStatus) {
	// PERF:
	let target_type = type_from_value_node(node.target);
	if (!target_type?.name && node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		if (name === "self" && status.current_struct) {
			target_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(name)) {
			target_type = status.variable_types.get(name)!;
		} else {
			const decl = status.scoped_declarations.findLast((d) => d.name === name);
			if (decl?.type?.name) {
				target_type = decl.type;
			}
		}
	}
	// Method-call result receiver (e.g. `self.keys.load_T(k).hash()` in a
	// monomorphized generic body): the AccessFunctionCallNode's cached `.type`
	// may carry a stale generic type param ("T") or be empty. Resolve the
	// actual return type by walking the access chain through the structs.
	if (
		node.target.node_type === "access" &&
		(!target_type?.name || !status.structs.find((s) => s.name === target_type.name))
	) {
		const resolved = resolve_access_type(node.target as AccessNode, status);
		if (resolved?.name) target_type = resolved;
	}
	// A bare variable's ValueNode.type may not carry `is_view` (the checker
	// stores the full declared type on the declaration, not always on each
	// use-site ValueNode). Recover it from variable_types so view access ops
	// (`.length`, `.at`, `.to_string`) are recognized.
	if (
		!target_type.is_view &&
		node.target.node_type === "value" &&
		status.variable_types?.has((node.target as ValueNode).value)
	) {
		const vt = status.variable_types.get((node.target as ValueNode).value)!;
		if (vt.is_view) target_type = vt;
	}
	const trait = status.traits.find((t) => t.name === target_type.name);
	const enum_node = status.enums.find((e) => e.name === target_type.name);
	const bitset_node = status.bitsets.find((b) => b.name === target_type.name);

	switch (node.access.node_type) {
		case "access_field": {
			const access_field = node.access as AccessFieldNode;
			// Variadic param .length → hidden _name_len parameter
			if (
				target_type.is_array &&
				access_field.name === "length" &&
				node.target.node_type === "value" &&
				status.function_variadic_params?.has((node.target as ValueNode).value)
			) {
				status.code += `_${(node.target as ValueNode).value}_len`;
				return;
			}
			// Heap array .length → pointer field access (result->length)
			if (
				target_type.is_array &&
				access_field.name === "length" &&
				node.target.node_type === "value" &&
				status.heap_array_vars?.has((node.target as ValueNode).value)
			) {
				build_node(node.target, status);
				status.code += `->length`;
				return;
			}
			// Heap `Array<T>` field / expression .length → the value is a
			// `struct Array_<T>*` pointer, so `.length` is `->length`.
			if (target_type.is_array && target_type.is_array_heap && access_field.name === "length") {
				build_node(node.target, status);
				status.code += `->length`;
				return;
			}
			// HACK:
			if (target_type.is_array && access_field.name === "length") {
				const type = c_type(target_type.name);
				status.code += "(sizeof(";
				build_node(node.target, status);
				status.code += `) / sizeof(${type}))`;
				return;
			}
			// view T.length — the slice's stored length (a real field on the
			// universal nomen_view struct, no strlen). Must precede the
			// string.length case: a view string also has name "string".
			if (target_type.is_view && access_field.name === "length") {
				build_node(node.target, status);
				status.code += `.len`;
				return;
			}
			// string.length — computed property that the check pass types as int
			// (see check_access_node). There's no `length` field on the C `char*`,
			// so lower it to `strlen`.
			if (target_type.name === "string" && access_field.name === "length") {
				emit_string_length(node.target, status);
				return;
			}
			if (enum_node) {
				const enum_case = enum_node.cases.find((c) => c.name === access_field.name);
				if (enum_case) {
					if (enum_node.has_associated_data) {
						status.code += `${enum_node.name}_${enum_case.name}_init()`;
					} else {
						status.code += `${enum_node.name}_${enum_case.name}`;
					}
					return;
				}
			}
			// Enum payload field access (e.g. `insect.alive` where `alive` is
			// a field of the `still_alive` case): lower to the union path
			// `target._data._case_name.field_name`.
			if (enum_node?.has_associated_data) {
				for (const c of enum_node.cases) {
					const param = c.params?.find((p) => p.name === access_field.name);
					if (param) {
						const target_value =
							node.target.node_type === "value" ? (node.target as ValueNode).value : "";
						const target_is_ref = !!status.function_ref_params?.has(target_value);
						if (target_is_ref) status.suppress_dereference = true;
						build_node(node.target, status);
						status.suppress_dereference = false;
						status.code += target_is_ref
							? `->_data._${c.name}.${access_field.name}`
							: `._data._${c.name}.${access_field.name}`;
						return;
					}
				}
			}
			if (bitset_node) {
				if (bitset_node.cases.includes(access_field.name)) {
					status.code += `${bitset_node.name}_${access_field.name}`;
					return;
				}
			}
			// Static function reference (e.g. `Console.write` used as a value,
			// not called). Emit the mangled C function name instead of the
			// dotted Nomen name. A struct field with the same name as a method
			// (e.g. Graph.edge_target) takes precedence — only treat this as a
			// function reference when there is no colliding field.
			if (target_type.name) {
				const target_struct = status.structs.find(
					(s) =>
						s.name === target_type.name &&
						s.functions?.some((f) => f.name === access_field.name) &&
						!s.fields?.some((f) => f.name === access_field.name),
				);
				if (target_struct) {
					// A static method reference as a VALUE materializes its
					// closure descriptor (CLOSURE.md) — the target
					// method's signature is unchanged; the descriptor's thunk
					// forwards (env, args...). The method's emission label is
					// the `Struct_method` convention (the same name the
					// non-value path emits below).
					const method = target_struct.functions.find((f) => f.name === access_field.name);
					if (method) {
						const conventional = `${target_type.name}_${access_field.name.replace(/#/g, "")}`;
						if (!method.label_name) method.label_name = conventional;
						status.code += materialize_func_value(method, status);
						return;
					}
					const fn_c_name = access_field.name.replace(/#/g, "");
					status.code += `${target_type.name}_${fn_c_name}`;
					return;
				}
			}
			if (trait) {
				// If the target is a trait, we need to call the get/set method
				const traitField = trait.fields.find((f) => f.name == access_field.name)!;
				// Struct field types need the `struct` tag in C; scalars/strings
				// lower via c_type directly. Multi-word struct trait fields are
				// returned by value through the get accessor. The tag (plain
				// name) is never mangled — only the typedef is.
				const field_is_struct = !!status.structs.find(
					(s) => s.name === traitField.type.name && !s.is_simple_type,
				);
				const type = field_is_struct
					? `struct ${traitField.type.name}`
					: c_type(traitField.type.name);
				const cast = `(${type}(*)(void *))`;
				status.code += `(${cast}_get_trait_func((void *)`;
				build_vtable_target(node.target, status);
				const trait_index = status.traits.indexOf(trait);
				const field_index = trait.functions.length + trait.fields.indexOf(traitField) * 2;
				status.code += `, ${trait_index}, ${field_index}))(`;
				build_vtable_target(node.target, status);
				status.code += `)`;
				break;
			} else {
				const target_value =
					node.target.node_type === "value" ? (node.target as ValueNode).value : "";
				// `self` is always emitted as a pointer in the generated C
				// (matching aarch64). It lives in function_ref_params whenever
				// it's a pointer param (regular/var/ref self) and is absent
				// only for a custom #init's local by-value `self`. So the
				// generic function_ref_params check is correct for self too,
				// without the old `self_is_ref` special-casing.
				// For chained access (e.g. `h2.content.value`), the target
				// (`h2.content`) may be a class pointer even though it's not a
				// bare variable — check target_type too.
				const target_type_is_class = !!status.structs.find(
					(s) => s.name === target_type?.name && s.is_class,
				);
				const target_is_ref =
					!!status.function_ref_params?.has(target_value) ||
					!!status.class_vars?.has(target_value) ||
					target_type_is_class;
				// A `ref` class param is a double pointer (`struct T **`); a
				// field read needs `(*target)->field`.
				if (status.ref_class_params?.has(target_value)) {
					status.code += `(*${target_value})->${access_field.name}`;
					break;
				}
				if (target_is_ref) {
					// The target is a pointer param; `->` dereferences it, so
					// don't let build_value_node emit `*target`.
					status.suppress_dereference = true;
				}
				build_node(node.target, status);
				status.suppress_dereference = false;
				status.code += target_is_ref ? `->${access_field.name}` : `.${access_field.name}`;
			}
			break;
		}
		case "access_func": {
			const access_func = node.access as AccessFunctionCallNode;
			// Thread.start / Thread.detach / Fiber.start are ordinary
			// methods on the library classes (ASYNC.md);
			// start_on's checker rewrites it to start after validating the
			// stack buffer.
			// Escape hatch: `nursery.start(Thread(fn(args)))` — the single
			// parameter is the Thread construction (or a Thread-typed
			// expression); launch its packed closure and register the future
			// with the receiver Nursery's runtime futures/count pointers.
			// See ASYNC.md.
			if (access_func.is_nursery_spawn) {
				const nursery_ptr = nursery_pointer_expr(node.target, status);
				build_nursery_spawn(access_func, nursery_ptr, status);
				return;
			}
			// `s.f(args)` where `f` is a func-typed FIELD: an indirect call
			// through the stored code pointer, cast to the field's signature.
			if (access_func.is_func_field_call) {
				build_func_field_call(node, access_func, status);
				return;
			}
			// `view T` builtins operate on the universal (ptr, len) slice directly:
			//   v.at(i)       →  ((Elem*)v.ptr)[i]
			//   v.slice(s, e) →  re-rooted sub-view (string views; no copy)
			//   v.to_string() →  malloc(len+1); memcpy; null-terminate (owned copy)
			//     (slice/to_string are string-only; at works for any view.)
			// Views are read-only — there is no `.set`.
			if (target_type.is_view) {
				if (access_func.name === "at" && access_func.params.length === 1) {
					const elem = view_element_c_type(target_type, status);
					status.code += `((${elem}*)`;
					status.suppress_dereference = true;
					build_node(node.target, status);
					status.suppress_dereference = false;
					status.code += `.ptr)[`;
					build_node(access_func.params[0], status);
					status.code += `]`;
					return;
				}
				if (
					access_func.name === "slice" &&
					target_type.name === "string" &&
					access_func.params.length === 2
				) {
					// view string slice → sub-view: re-root the (ptr, len)
					// pair without copying. Without this arm a view receiver
					// fell through to `string_slice(nomen_string, ...)` and
					// failed to compile (nomen_view vs nomen_string).
					const id = (status.label_counter = (status.label_counter ?? 0) + 1);
					const tmp = `_vsl_${id}`;
					status.code += `({ nomen_view ${tmp} = `;
					build_node(node.target, status);
					status.code += `; long _s = `;
					build_node(access_func.params[0], status);
					status.code += `; nomen_view _r; _r.ptr = (void*)((char*)${tmp}.ptr + _s); _r.len = (long)(`;
					build_node(access_func.params[1], status);
					status.code += ` - _s); _r; })`;
					return;
				}
				if (access_func.name === "to_string" && target_type.name === "string") {
					// view string → owned fat string: the len is already on the
					// view — copy exactly len bytes and NUL-terminate.
					const id = (status.label_counter = (status.label_counter ?? 0) + 1);
					const tmp = `_vts_${id}`;
					status.code += `({ nomen_view ${tmp} = `;
					build_node(node.target, status);
					status.code += `; char* _p = malloc(${tmp}.len + 1); memcpy(_p, ${tmp}.ptr, ${tmp}.len); _p[${tmp}.len] = 0; (nomen_string){ _p, ${tmp}.len }; })`;
					return;
				}
			}
			// Inline .at()/.set()/.first() on plain C arrays (target_type.is_array
			// with a known length means a stack/local C array, not an Array_*
			// struct). Variadic params are also plain C arrays (`T *name`),
			// so they hit this path too. Heap arrays (returned from functions)
			// must NOT inline — they use the Array_<T>_at/_first helpers.
			// Heap arrays — locals/params registered in heap_array_vars AND
			// `Array<T>`-typed fields (is_array_heap, whose field value is a
			// `struct Array_<T>*` pointer) — must NOT inline; they use the
			// Array_<T>_at/_set/_first helpers.
			const target_is_heap_array =
				target_type.is_array_heap ||
				(node.target.node_type === "value" &&
					!!status.heap_array_vars?.has((node.target as ValueNode).value));
			const wants_inline =
				target_type.is_array &&
				!target_is_heap_array &&
				((access_func.name === "at" && access_func.params.length === 1) ||
					(access_func.name === "set" && access_func.params.length === 2) ||
					(access_func.name === "first" && access_func.params.length === 0) ||
					(access_func.name === "slice" && access_func.params.length === 2));
			if (wants_inline) {
				if (access_func.name === "at") {
					status.code += `(`;
					status.suppress_dereference = true;
					build_node(node.target, status);
					status.suppress_dereference = false;
					status.code += `[`;
					build_node(access_func.params[0], status);
					status.code += `])`;
					break;
				}
				if (access_func.name === "set") {
					status.suppress_dereference = true;
					build_node(node.target, status);
					status.suppress_dereference = false;
					status.code += `[`;
					build_node(access_func.params[0], status);
					status.code += `] = `;
					build_node(access_func.params[1], status);
					break;
				}
				if (access_func.name === "first") {
					status.code += `(`;
					status.suppress_dereference = true;
					build_node(node.target, status);
					status.suppress_dereference = false;
					status.code += `[0])`;
					break;
				}
				// slice on a plain C array: build a nomen_view (ptr, len) over
				// [start, end) using C pointer arithmetic (the element width is
				// implicit in the array's type). Statement-expression so each
				// operand evaluates once.
				if (access_func.name === "slice") {
					status.code += `({ nomen_view _r; long _s = `;
					build_node(access_func.params[0], status);
					status.code += `; _r.ptr = (void*)(`;
					status.suppress_dereference = true;
					build_node(node.target, status);
					status.suppress_dereference = false;
					status.code += ` + _s); _r.len = (long)(`;
					build_node(access_func.params[1], status);
					status.code += ` - _s); _r; })`;
					break;
				}
			}
			if (enum_node) {
				const enum_case = enum_node.cases.find((c) => c.name === access_func.name);
				if (enum_case) {
					// An owned class/trait LOCAL passed to an owning case
					// payload transfers ownership (check records the arg in
					// move_param_indices): splice its declaration out of the
					// scope frames so auto_free won't free the instance the
					// payload now owns (double-free).
					if (access_func.move_param_indices?.length) {
						for (const idx of access_func.move_param_indices) {
							const arg = access_func.params[idx];
							if (arg?.node_type !== "value") continue;
							const decl_hit = find_decl_in_c_scopes(status, (arg as ValueNode).value);
							if (decl_hit) decl_hit.frame.splice(decl_hit.index, 1);
						}
					}
					status.code += `${enum_node.name}_${enum_case.name}_init(`;
					for (let i = 0; i < access_func.params.length; i++) {
						if (i > 0) {
							status.code += ", ";
						}
						build_node(access_func.params[i], status);
					}
					status.code += ")";
					break;
				}
			}
			// Borrow-position `to_string()` elision (STRING_PLAN tranche 3): the
			// checker verified the consumer takes the receiver's bytes as a plain
			// `string` borrow and cannot mutate them — emit the receiver
			// expression itself instead of `string_to_string(receiver)` (strdup);
			// no temporary is created, so nothing is freed.
			if (
				access_func.borrow_to_string &&
				target_type.name === "string" &&
				!target_type.is_view &&
				!target_type.is_array
			) {
				build_node(node.target, status);
				break;
			}
			// `.to_string()` on a string-typed receiver compiles to
			// `string_to_string(receiver)`, whose _raw_ body strdups its
			// argument and returns a fresh owned copy. When the receiver is
			// itself an owned heap temporary (e.g. a method call like
			// `f.greet().to_string()` used inside a string interpolation),
			// the strdup'd input leaks — nobody frees it. Wrap in a clang
			// statement-expression that frees the temporary after
			// string_to_string has copied it.
			if (
				access_func.name === "to_string" &&
				target_type.name === "string" &&
				is_owned_heap_temp(node.target, status)
			) {
				const id = (status.label_counter = (status.label_counter ?? 0) + 1);
				const tmp = `_sts_${id}`;
				status.code += `({ nomen_string ${tmp} = `;
				build_node(node.target, status);
				status.code += `; nomen_string _sto_${id} = string_to_string(${tmp}); free(${tmp}.ptr); _sto_${id}; })`;
				break;
			}
			if (
				access_func.name === "to_string" &&
				(status.enums.find((e) => e.name === target_type.name) ||
					status.bitsets.find((b) => b.name === target_type.name))
			) {
				const enum_node_for_ts = status.enums.find((e) => e.name === target_type.name);
				status.code += `int_to_string(`;
				build_node(node.target, status);
				if (enum_node_for_ts?.has_associated_data) {
					status.code += `.tag`;
				}
				status.code += ")";
				break;
			}
			// to_string on a fixed-size C array (e.g. `Array(1, 2, 3)` which
			// is lowered to `long arr[3] = {1, 2, 3}`). The array is NOT an
			// Array<T> struct, so Array_int_to_string can't be called. Instead,
			// inline a GCC statement expression that iterates the elements,
			// calls `<elem>_to_string` on each, and concatenates the results.
			if (access_func.name === "to_string" && target_type.is_array && target_type.length) {
				const elem_name = target_type.name;
				const to_string_fn = `${elem_name}_to_string`;
				const len = (target_type.length as any).value || "0";
				// Heap arrays (struct Array_T*) store data past the header struct;
				// fixed-size C arrays (T arr[N]) index directly.
				const target_name =
					node.target.node_type === "value" ? (node.target as ValueNode).value : "";
				const is_heap = !!target_name && !!status.heap_array_vars?.has(target_name);
				status.code += `({ char* _ts_r = (char*)malloc(1); _ts_r[0] = 0; long _ts_n = 0; for (long _i = 0; _i < ${len}; _i++) { nomen_string _s = ${to_string_fn}(`;
				if (is_heap) {
					status.code += `((${c_type(elem_name)}*)((char*)`;
					build_node(node.target, status);
					status.code += ` + sizeof(struct Array_${elem_name})))[_i]`;
				} else {
					build_node(node.target, status);
					status.code += `[_i]`;
				}
				status.code += `); _ts_n += _s.len; _ts_r = (char*)realloc(_ts_r, _ts_n + 1); strcat(_ts_r, _s.ptr); free(_s.ptr); } (nomen_string){ _ts_r, _ts_n }; })`;
				status.last_result_is_heap = true;
				break;
			}
			if (trait) {
				// Dispatch through the vtable: resolve the concrete function
				// pointer via _get_trait_func(obj, trait_index, func_index),
				// then call it. The function-pointer cast is derived from the
				// trait method's declared signature so the call type-checks for
				// any return type or arity. The vtable entry conforms to that
				// signature: `self` (a struct pointer) appears only when the
				// trait method declares it, followed by each real parameter.
				// Struct/trait parameters are passed by pointer, matching how
				// concrete methods lower them.
				const trait_func = trait.functions.find((f) => f.name == access_func.name)!;
				const trait_index = status.traits.indexOf(trait);
				const func_index = trait.functions.indexOf(trait_func);
				const has_self = trait_func.params.some((p) => p.is_self_param);

				// An INLINE capturing lambda argument to the func-typed
				// parameter is a one-shot heap descriptor the callee only
				// borrows (CLOSURE.md) — capture each into a wrapper-declared
				// temp at its argument position and reclaim once the dispatch
				// returns. The wrapper opens here (outside the receiver temp's
				// own statement expression) and closes after the dispatch.
				const trait_callee_params = trait_func.params.filter((p) => !p.is_self_param);
				const lambda_arg_temps = new Map<number, string>();
				for (let i = 0; i < access_func.params.length; i++) {
					const p = access_func.params[i];
					if (p.node_type !== "func") continue;
					if (!(p as FunctionNode).captures?.length) continue;
					const tp = trait_callee_params[i];
					if (!tp || !(tp.func_params || tp.func_return_type)) continue;
					lambda_arg_temps.set(i, next_lambda_arg_temp());
				}
				if (lambda_arg_temps.size > 0) {
					status.code += `({ `;
					for (const tmp of lambda_arg_temps.values()) {
						status.code += `struct nomen_closure *${tmp}; `;
					}
				}
				let lambda_ret_tmp: string | undefined;

				// A generic trait's method signature references its type params
				// (e.g. `out T`), which are unresolved at the trait level. The
				// per-conformer default bodies are synthesized + substituted, so
				// the vtable entry returns the concrete type — but this dispatch
				// cast is derived from the trait's declared signature, so it
				// would emit an unknown C type (`T`). Resolve each type param
				// against the receiver's declared type args when present
				// (`Box<int>` → T=int), falling back to the erased word type
				// (`long`) for a bare erased trait receiver.
				const trait_subst = new Map<string, string>();
				if (trait.type_params.length > 0) {
					for (let k = 0; k < trait.type_params.length; k++) {
						const arg = target_type?.type_args?.[k]?.name;
						trait_subst.set(trait.type_params[k], arg || "long");
					}
				}
				const subst_c_type = (name: string): string => {
					const resolved = trait_subst.get(name) || name;
					const is_struct = !!status.structs.find((s) => s.name === resolved && !s.is_simple_type);
					return is_struct ? `struct ${resolved}` : c_type(resolved);
				};

				const ret_name =
					trait_subst.get(trait_func.return_type?.name || "") || trait_func.return_type?.name;
				const ret_is_struct =
					!!ret_name && !!status.structs.find((s) => s.name === ret_name && !s.is_simple_type);
				const ret_c = !trait_func.return_type?.name
					? "void"
					: ret_is_struct
						? `struct ${ret_name}`
						: c_type(ret_name);
				// The ret-forward temp is decided here (after the dispatch's own
				// return type is known): when the owned-receiver path below
				// already forwards the result (`recv_ret_temp`), its yield
				// doubles as ours.
				const lambda_ret_forwardable = lambda_arg_temps.size > 0 && ret_c !== "void";

				const cast_params: string[] = [];
				if (has_self) cast_params.push("void *");
				for (const p of trait_func.params) {
					if (p.is_self_param) continue;
					const resolved_p = trait_subst.get(p.type.name) || p.type.name;
					const is_struct_or_trait =
						!!status.structs.find((s) => s.name === resolved_p && !s.is_simple_type) ||
						!!status.traits.find((t) => t.name === resolved_p);
					cast_params.push(is_struct_or_trait ? "void *" : subst_c_type(p.type.name));
				}
				const cast = `(${ret_c} (*)(${cast_params.join(", ") || "void"}))`;

				// An rvalue receiver (a call result, e.g.
				// `rules.at_or_panic(0).name()`): the call already yields the
				// instance pointer, so taking `&` is both invalid C and the
				// wrong value — and emitting the call twice would duplicate
				// side effects. Materialize it once into a statement-expression
				// temp and reuse that slot for both the vtable lookup and the
				// self argument. (Plain values and field accesses are lvalues
				// and keep the address-of path below.)
				const recv_is_rvalue =
					node.target.node_type === "func_call" ||
					(node.target.node_type === "access" &&
						(node.target as AccessNode).access.node_type === "access_func");
				let recv_temp: string | undefined;
				let recv_temp_owned = false;
				let recv_ret_temp: string | undefined;
				if (recv_is_rvalue) {
					const saved = begin_code_scratch(status);
					status.suppress_dereference = true;
					build_node(node.target, status);
					status.suppress_dereference = false;
					const recv_expr = end_code_scratch(status, saved);
					const id = (status.label_counter = (status.label_counter ?? 0) + 1);
					recv_temp = `_trrecv_${id}`;
					status.code += `({ void *${recv_temp} = (void*)(${recv_expr}); `;
					// An owned receiver (a `move out T` call like pop()): the
					// temp owns the instance, so it must be destroyed after
					// the dispatch — mirroring the scope-exit reclaim an
					// owned trait-typed local gets. The dispatch result is
					// carried out in its own temp so the free can run last.
					recv_temp_owned =
						node.target.node_type === "access" &&
						!!((node.target as AccessNode).access as AccessFunctionCallNode).owned_return;
					if (recv_temp_owned && ret_c !== "void") {
						recv_ret_temp = `_trret_${id}`;
						status.code += `${ret_c} ${recv_ret_temp} = `;
					}
				}
				// Forward the dispatch value out of the lambda wrapper (the
				// dispose arms after the call would otherwise void it).
				if (lambda_ret_forwardable && !recv_ret_temp) {
					lambda_ret_tmp = next_lambda_ret_temp();
					status.code += `${ret_c} ${lambda_ret_tmp} = `;
				}

				status.code += `(${cast}_get_trait_func(`;
				if (recv_temp) {
					status.code += `(void *)${recv_temp}`;
				} else {
					build_vtable_target(node.target, status);
				}
				status.code += `, ${trait_index}, ${func_index}))(`;

				// Receiver pointer is the first call argument only when the
				// method declares self.
				let need_comma = false;
				if (has_self) {
					if (recv_temp) {
						status.code += `(void *)${recv_temp}`;
					} else {
						build_vtable_target(node.target, status);
					}
					need_comma = true;
				}
				for (let i = 0; i < access_func.params.length; i++) {
					if (need_comma) status.code += ", ";
					need_comma = true;
					// An inline capturing lambda arg: capture its one-shot heap
					// descriptor into the wrapper temp (handled before the
					// type-based routing — the lambda's VALUE-node type is its
					// RETURN type and must not select the struct/erasure paths).
					const lambda_tmp = lambda_arg_temps.get(i);
					if (lambda_tmp) {
						status.code += `(${lambda_tmp} = `;
						build_node(access_func.params[i], status);
						status.code += `)`;
						continue;
					}
					const param_type = type_from_value_node(access_func.params[i]);
					const param_value =
						access_func.params[i].node_type === "value"
							? (access_func.params[i] as ValueNode).value
							: "";
					const arg_is_struct_or_trait =
						!!status.structs.find((s) => s.name === param_type.name && !s.is_simple_type) ||
						!!status.traits.find((t) => t.name === param_type.name) ||
						!!status.class_vars?.has(param_value);
					if (arg_is_struct_or_trait) {
						// A `ref T` callee param (T a class/trait) takes the
						// caller's SLOT by pointer (`T **`). An arg that is
						// itself a `ref` param already IS the slot pointer —
						// forward it as-is. A plain class LOCAL is a single
						// `T *` — pass `&local` (dropping the address-of made
						// the callee dereference the instance as the slot).
						// A non-ref `T` param takes the instance pointer: a
						// class/trait-backed arg passes bare, a value-struct
						// arg passes by pointer (`&`).
						const non_self_trait_params = trait_func.params.filter((p) => !p.is_self_param);
						const trait_param = non_self_trait_params[i];
						const callee_wants_ref = !!(
							trait_param &&
							(trait_param.is_ref || trait_param.type?.is_ref)
						);
						const arg_is_ref_slot =
							!!status.ref_class_params?.has(param_value) ||
							!!status.function_ref_params?.has(param_value);
						if (callee_wants_ref) {
							if (arg_is_ref_slot) {
								status.suppress_dereference = true;
							} else {
								status.code += "&";
							}
						} else {
							const arg_is_class_backed =
								!!status.structs.find((s) => s.name === param_type.name && s.is_class) ||
								!!status.traits.find((t) => t.name === param_type.name) ||
								!!status.class_vars?.has(param_value);
							if (!arg_is_class_backed) {
								status.code += "&";
							} else {
								status.suppress_dereference = true;
							}
						}
						build_node(access_func.params[i], status);
						status.suppress_dereference = false;
					} else {
						build_node(access_func.params[i], status);
					}
				}
				status.code += `)`;
				if (lambda_arg_temps.size > 0) {
					for (const tmp of lambda_arg_temps.values()) {
						status.code += `; ${closure_dispose_arm(tmp)}`;
					}
					if (lambda_ret_tmp) status.code += `; ${lambda_ret_tmp}`;
					if (!recv_temp) {
						// No receiver statement expression: this wrapper is the
						// only one — close it here.
						status.code += `; })`;
					}
				}
				if (recv_temp) {
					if (recv_temp_owned) {
						status.code += `; ${trait.name}_destroy(${recv_temp}); free(${recv_temp})`;
						if (recv_ret_temp) {
							status.code += `; ${recv_ret_temp}`;
						}
					}
					status.code += `; })`;
				}
			} else {
				let method_type: Type | undefined = target_type;
				if (!method_type?.name && node.target.node_type === "access") {
					method_type = resolve_access_field_type(node.target as AccessNode, status);
				}
				// If the AccessFieldNode type is an unresolved generic (e.g.
				// Buffer<T> inside a monomorphized method body whose node
				// types were not substituted), try resolving from the struct
				// definition directly — the field's type WAS rewritten during
				// monomorphization (Buffer<T> → ClassBuffer_Animal).
				if (
					method_type?.type_args?.length &&
					node.target.node_type === "access" &&
					!status.structs.find((s) => s.name === mono_type_name(method_type!) && !s.is_generic)
				) {
					const resolved = resolve_access_field_type(node.target as AccessNode, status);
					if (resolved?.name) method_type = resolved;
				}
				let mono_struct_name = method_type?.is_array
					? "Array_" + method_type.name
					: method_type
						? mono_type_name(method_type)
						: "";
				if (
					!access_func.mangled_name &&
					mono_struct_name &&
					!status.structs.find((s) => s.name === mono_struct_name && !s.is_generic)
				) {
					const sname = mono_struct_name + "_";
					const specialized = status.structs.find(
						(s) =>
							s.name.startsWith(sname) &&
							!s.is_generic &&
							s.functions.find((f) => f.name === access_func.name),
					);
					if (specialized) mono_struct_name = specialized.name;
				}
				// Look up the target method to detect type erasure (class
				// pointer passed to a type-erased long parameter, e.g.
				// ClassBuffer.store_int).
				const target_struct_for_method = mono_struct_name
					? status.structs.find((s) => s.name === mono_struct_name && !s.is_generic)
					: undefined;
				const target_method = target_struct_for_method?.functions.find(
					(f) => f.name === access_func.name,
				);
				// A value-struct method may overwrite the receiver's plain
				// string fields through `self` — writes the caller's
				// heap_string_fields records can't reflect (the method can't
				// know the displaced values' ownership; see the
				// `target_var !== "self"` gate in build_assignment_node). Drop
				// the records for the fields the method writes so the
				// receiver's scope-exit cleanup never frees a value the method
				// replaced with a non-heap one. Conservative: a heap value the
				// method wrote leaks instead of being freed.
				if (
					node.target.node_type === "value" &&
					target_struct_for_method &&
					!target_struct_for_method.is_class &&
					target_method
				) {
					drop_self_written_string_field_records(
						status,
						(node.target as ValueNode).value,
						scan_self_string_field_writes(target_struct_for_method, target_method),
					);
				}
				const self_offset = target_method?.params?.some((p) => p.is_self_param) ? 1 : 0;
				// If the method doesn't exist on the struct, check if it's a
				// trait default method inherited by this struct.
				let trait_default_label = "";
				let trait_default_func: FunctionNode | undefined;
				if (mono_struct_name && !access_func.mangled_name) {
					const struct_node = status.structs.find(
						(s) => s.name === mono_struct_name && !s.is_generic,
					);
					if (struct_node && !struct_node.functions.find((f) => f.name === access_func.name)) {
						for (const trait_name of struct_node.traits) {
							const trait = status.traits.find((t) => t.name === trait_name);
							if (trait) {
								const trait_func = trait.functions.find(
									(f) => f.name === access_func.name && f.has_body,
								);
								if (trait_func) {
									trait_default_label = `${trait_name}_${access_func.name}`;
									trait_default_func = trait_func;
									break;
								}
							}
						}
					}
				}
				// An INLINE capturing lambda argument to the func-typed
				// parameter is a one-shot heap descriptor the callee only
				// borrows (CLOSURE.md) — capture each into a wrapper-declared
				// temp at its argument position and reclaim once the call
				// returns. The wrapper opens before the receiver/array
				// statement expressions and closes after the call.
				const method_callee_params = (target_method ?? trait_default_func)?.params?.filter(
					(p) => !p.is_self_param,
				);
				const lambda_arg_temps = new Map<number, string>();
				for (let i = 0; i < access_func.params.length; i++) {
					const p = access_func.params[i];
					if (p.node_type !== "func") continue;
					if (!(p as FunctionNode).captures?.length) continue;
					const mp = method_callee_params?.[i];
					if (!mp || !(mp.func_params || mp.func_return_type)) continue;
					lambda_arg_temps.set(i, next_lambda_arg_temp());
				}
				if (lambda_arg_temps.size > 0) {
					status.code += `({ `;
					for (const tmp of lambda_arg_temps.values()) {
						status.code += `struct nomen_closure *${tmp}; `;
					}
				}
				const lambda_ret_c =
					lambda_arg_temps.size > 0
						? c_return_type((target_method ?? trait_default_func)?.return_type, status)
						: undefined;
				const lambda_ret_tmp =
					lambda_ret_c && lambda_ret_c !== "void" ? next_lambda_ret_temp() : undefined;
				const label =
					access_func.mangled_name ||
					trait_default_label ||
					`${mono_struct_name}_${access_func.name.replace(/#/g, "")}`;
				// A non-heap Array receiver must be wrapped in a header temp
				// before the callee's `struct Array_<T>* self` (see
				// array_receiver_wrap) — decided here so the statement
				// expression can surround the call text emitted below.
				const array_wrap = array_receiver_wrap(
					node,
					method_type,
					target_method,
					mono_struct_name,
					status,
				);
				if (array_wrap) {
					status.code += array_wrap.prefix;
				}
				// A chained spawn-class construction receiver
				// (`Thread(fn(args)).start()`) is a TEMPORARY instance: the
				// launch transfers its handles out (the instance's #destroy
				// is then a no-op) and the instance itself must be freed —
				// the call is wrapped in a statement expression that does
				// exactly that. A stored binding is freed by its owner.
				// ASYNC.md: the old build_thread_start /
				// build_thread_detach `target_is_temp` free, moved to the
				// receiver emission now that start/detach are ordinary
				// methods. Keyed on the construction flags, never the name.
				const ctor_target_node =
					node.target.node_type === "func_call"
						? (node.target as unknown as {
								is_thread_ctor?: boolean;
								is_fiber_ctor?: boolean;
								is_awaitable_ctor?: boolean;
							})
						: undefined;
				const ctor_temp_receiver = !!(
					ctor_target_node &&
					(ctor_target_node.is_thread_ctor ||
						ctor_target_node.is_fiber_ctor ||
						ctor_target_node.is_awaitable_ctor)
				);
				let ctor_temp_free: string | undefined;
				let ctor_temp_val: string | undefined;
				if (ctor_temp_receiver) {
					const id = (status.label_counter = (status.label_counter ?? 0) + 1);
					ctor_temp_free = `_ctorr_${id}`;
					const ctor_mono = mono_type_name(type_from_value_node(node.target));
					status.code += `({ struct ${ctor_mono} *${ctor_temp_free} = `;
					{
						const saved_suppress = status.suppress_dereference;
						status.suppress_dereference = true;
						build_node(node.target, status);
						status.suppress_dereference = saved_suppress;
					}
					status.code += `; `;
					// A non-void launch yields Task<T>: capture the call's
					// result into a temp so the free can follow the call and
					// the statement expression still yields the handle (the
					// last EXPRESSION statement is the value). The type comes
					// from the call's substituted type (the method's declared
					// return is still generic — `Task<T>`).
					const ret = (target_method ?? trait_default_func)?.return_type;
					if (ret?.name && ret.name !== "void") {
						const mono_ret = mono_type_name(access_func.type);
						const ret_is_ptr =
							!!status.structs.find((s) => s.name === mono_ret && s.is_class) ||
							!!status.traits.find((t) => t.name === mono_ret);
						const ret_c = ret_is_ptr ? `struct ${mono_ret} *` : c_type(mono_ret);
						ctor_temp_val = `_ctorv_${id}`;
						status.code += `${ret_c} ${ctor_temp_val} = `;
					}
				}
				if (lambda_ret_tmp) {
					status.code += `${lambda_ret_c} ${lambda_ret_tmp} = `;
				}
				status.code += `${label}(`;
				if (!access_func.is_static) {
					if (ctor_temp_free) {
						// The wrapped temp is already the instance pointer.
						status.code += ctor_temp_free;
					} else if (array_wrap) {
						status.code += array_wrap.self_expr;
					} else {
						// Emit the receiver (`self`) for a method call. A plain local
						// instance is passed by address (`&`); a pointer param/var is
						// forwarded as-is; a `ref` class param (`struct T **`) is
						// dereferenced once to yield the single pointer `self` expects.
						// A `ref self` method (e.g. string.set) takes the caller's slot
						// by pointer even for built-in types — its `T *self` param is
						// one indirection deeper than the by-value convention the
						// simple-type methods (string.at & co.) use.
						const method_self_is_ref = !!target_method?.params?.some(
							(p) => p.is_self_param && (p.is_ref || p.type?.is_ref),
						);
						// A `view T` receiver calling a method whose `self` is the
						// OWNED pair type (any string method on `view string`): the
						// view and the owned pair share the same 16-byte (ptr, len)
						// ABI, so alias the view into the callee's pair — no copy,
						// matching what aarch64 gets for free. Sound because
						// by-value self params are caller-owned (no string method
						// frees self). Statement-expression so the receiver
						// evaluates exactly once. (`ref self` methods are excluded
						// — they take the caller's slot by pointer below, and
						// views are read-only.)
						const method_self = target_method?.params?.find((p) => p.is_self_param);
						const view_receiver_alias =
							!method_self_is_ref &&
							!!method_type &&
							is_built_in_type(method_type.name) &&
							method_type.name === "string" &&
							!!method_self &&
							!method_self.type?.is_view &&
							is_view_value(node.target, status);
						if (!is_built_in_type(method_type?.name || "") || method_self_is_ref) {
							const target_value =
								node.target.node_type === "value" ? (node.target as ValueNode).value : "";
							// See field-access branch: self is a pointer whenever
							// it's in function_ref_params, so the generic check
							// covers it.
							const target_is_ref_class_param = !!status.ref_class_params?.has(target_value);
							const target_is_ref_param =
								!!status.function_ref_params?.has(target_value) ||
								!!status.class_vars?.has(target_value) ||
								!!status.heap_array_vars?.has(target_value);
							// A class-typed RECEIVER EXPRESSION (e.g. a container
							// element `rules.at(i)`) already evaluates to the
							// instance pointer — pass it as-is; `&expr` would be
							// `&` of an rvalue (clang: "cannot take the address of
							// an rvalue"). Mirrors build_vtable_target.
							const target_expr_type = type_from_value_node(node.target);
							const target_expr_is_class =
								!!target_expr_type?.name &&
								!!status.structs.find((s) => s.name === target_expr_type.name && s.is_class);
							if (!target_is_ref_param && !target_expr_is_class) {
								status.code += "&";
							} else if (target_is_ref_class_param) {
								// A `ref` class param is a double pointer (`struct T **`),
								// but the method's `self` is a single pointer. Leave
								// suppress_dereference off so build_value_node emits
								// `(*t)`, yielding the instance pointer self expects.
							} else {
								// target is already a pointer (var/ref param, or a
								// class-typed expression) — don't dereference it; we
								// want the pointer itself.
								status.suppress_dereference = true;
							}
						}
						if (view_receiver_alias) {
							const id = (status.label_counter = (status.label_counter ?? 0) + 1);
							const tmp = `_vra_${id}`;
							status.code += `({ nomen_view ${tmp} = `;
							build_node(node.target, status);
							status.code += `; (nomen_string){ (char*)${tmp}.ptr, ${tmp}.len }; })`;
						} else {
							build_node(node.target, status);
						}
						status.suppress_dereference = false;
					}
				}
				for (let i = 0; i < access_func.params.length; i++) {
					if (!access_func.is_static || i > 0) {
						status.code += ", ";
					}
					// An inline capturing lambda arg: capture its one-shot heap
					// descriptor into the wrapper temp (handled before the
					// type-based routing — the lambda's VALUE-node type is its
					// RETURN type and must not select the struct/erasure paths).
					const lambda_tmp = lambda_arg_temps.get(i);
					if (lambda_tmp) {
						status.code += `(${lambda_tmp} = `;
						build_node(access_func.params[i], status);
						status.code += `)`;
						continue;
					}
					// A `view string` parameter receives a (ptr, len)
					// nomen_view: a view-typed argument passes through; an
					// owned string expression is borrowed into the pair.
					if (access_func.view_param_indices?.includes(i)) {
						c_view_string_arg(access_func.params[i], status);
						continue;
					}
					const param_type = type_from_value_node(access_func.params[i]);
					const param_value =
						access_func.params[i].node_type === "value"
							? (access_func.params[i] as ValueNode).value
							: "";
					// A `null` literal arg to a fat `string` parameter: the
					// checker rewrote the arg's type to the param's. Emit the
					// zero pair — a bare `0` is a C type error against the
					// nomen_string param.
					if (
						param_type.name === "string" &&
						!param_type.is_view &&
						!param_type.is_array &&
						access_func.params[i].node_type === "value" &&
						(access_func.params[i] as ValueNode).value === "null"
					) {
						status.code += `(nomen_string){0, 0}`;
						continue;
					}
					// Also treat class_vars as struct/class args — ValueNode types
					// inside monomorphized method bodies may still be unresolved
					// generic param names (e.g. `T` instead of `Animal`).
					const arg_is_struct_or_trait =
						!!status.structs.find((s) => s.name === param_type.name && !s.is_simple_type) ||
						!!status.traits.find((t) => t.name === param_type.name) ||
						!!status.class_vars?.has(param_value);
					// Type erasure: when a class pointer is passed to a
					// type-erased long parameter (e.g. ClassBuffer.store_int
					// takes `long val` but receives a `struct Animal *`),
					// cast to (long). Only applies to class pointers — struct
					// args use the normal &-pass-by-pointer path.
					const arg_is_class =
						!!status.class_vars?.has(param_value) ||
						(!!param_type.name &&
							!!status.structs.find((s) => s.name === param_type.name && s.is_class));
					const target_param = target_method?.params[i + self_offset];
					const target_param_is_erased =
						arg_is_class &&
						!!target_param &&
						!status.structs.find((s) => s.name === target_param.type.name && !s.is_simple_type) &&
						!status.traits.find((t) => t.name === target_param.type.name);
					if (target_param_is_erased) {
						if (status.class_vars?.has(param_value) && !status.ref_class_params?.has(param_value)) {
							status.suppress_dereference = true;
						}
						status.code += `(long)`;
						build_node(access_func.params[i], status);
						status.suppress_dereference = false;
					} else if (arg_is_struct_or_trait) {
						const callee_param_is_ref = access_func.ref_param_indices?.includes(i);
						const param_is_ref_class_param = !!status.ref_class_params?.has(param_value);
						const param_is_ref_param =
							!!status.function_ref_params?.has(param_value) ||
							!!status.class_vars?.has(param_value);
						if (callee_param_is_ref && param_is_ref_class_param) {
							// Forwarding a `ref` class param to another `ref` param:
							// the arg is already a double pointer (`struct T **`),
							// which is exactly what the callee's ref param expects —
							// forward it as-is (no `&`, no dereference).
							status.suppress_dereference = true;
						} else if (!param_is_ref_param) {
							status.code += "&";
						} else if (param_is_ref_class_param) {
							// A `ref` class param is a double pointer (`struct T **`);
							// a struct/trait/class param wants the single pointer, so
							// let build_value_node dereference once (`(*t)`).
						} else {
							status.suppress_dereference = true;
						}
						build_node(access_func.params[i], status);
						status.suppress_dereference = false;
					} else {
						// A scalar `ref T` param receives the caller's storage
						// address (`long *r`) — emit `&` exactly like the free
						// function call path (build_function_call_node). An
						// argument that is itself a `ref` param or a class var
						// (already a pointer) is forwarded as-is; suppress the
						// dereference build_value_node would emit.
						if (access_func.ref_param_indices?.includes(i)) {
							if (
								access_func.params[i].node_type === "value" &&
								(status.function_ref_params?.has((access_func.params[i] as ValueNode).value) ||
									status.class_vars?.has((access_func.params[i] as ValueNode).value))
							) {
								status.suppress_dereference = true;
							} else {
								status.code += "&";
							}
						}
						build_node(access_func.params[i], status);
						status.suppress_dereference = false;
					}
				}
				status.code += ")";
				if (ctor_temp_free) {
					// Close the temp-receiver statement expression: the
					// launch consumed the handles, the instance is dead. A
					// captured result is yielded as the final expression.
					status.code += `; free(${ctor_temp_free});`;
					if (ctor_temp_val) status.code += ` ${ctor_temp_val};`;
					status.code += ` })`;
				}
				if (lambda_arg_temps.size > 0) {
					for (const tmp of lambda_arg_temps.values()) {
						status.code += `; ${closure_dispose_arm(tmp)}`;
					}
					if (lambda_ret_tmp) status.code += `; ${lambda_ret_tmp}`;
				}
				if (array_wrap) {
					status.code += array_wrap.suffix;
				}
				if (lambda_arg_temps.size > 0) {
					status.code += `; })`;
				}
			}
			// move parameter handling for method calls: same as
			// build_function_call_node — remove moved class vars / temporaries
			// from scoped_declarations so they won't be double-freed.
			if (access_func.move_param_indices) {
				for (const idx of access_func.move_param_indices) {
					const param = access_func.params[idx];
					if (param?.node_type === "value") {
						const vname = (param as ValueNode).value;
						// A `string` arg to a `move T` param keeps caller ownership
						// (an owning Buffer<string> strdup's its own copy), so do NOT
						// splice it — auto_free must reclaim the original. Resolve
						// the type from the declaration (a bare variable reference's
						// ValueNode.type is unset post-monomorphization).
						const decl_hit = find_decl_in_c_scopes(status, vname);
						const tname =
							decl_hit?.frame[decl_hit.index].type?.name ?? (param as ValueNode).type?.name;
						if (tname === "string") continue;
						// An enum-with-data `move` arg keeps caller ownership:
						// the owning Buffer/List store_T deep-copies it
						// (`<Enum>_copy`), so auto_free must reclaim the temp.
						if (tname && status.enums.find((e) => e.name === tname && e.has_associated_data))
							continue;
						const decl_struct = decl_hit
							? status.structs.find((s) => s.name === tname && !s.is_simple_type)
							: undefined;
						const is_value_struct = !!decl_struct && !decl_struct.is_class;
						// Splice from whichever scope frame holds the declaration —
						// a `move` inside an if/loop branch must also remove an
						// OUTER-scope variable, or that scope's exit cleanup reclaims
						// the value the callee now owns (double-free).
						if (decl_hit) decl_hit.frame.splice(decl_hit.index, 1);
						// See build_function_call_node: a moved VALUE struct's
						// recorded heap string fields are released here — the
						// callee's store_T deep-copied them, and the splice
						// removes the decl from auto_free's iteration.
						if (is_value_struct) {
							const prefix = `${vname}.`;
							for (const key of Array.from(status.heap_string_fields ?? [])) {
								if (key.startsWith(prefix)) {
									if (!status.pending_string_releases) status.pending_string_releases = [];
									status.pending_string_releases.push(`free(${key}.ptr);`);
									status.heap_string_fields!.delete(key);
								}
							}
						}
					}
				}
			}
			break;
		}
	}
}

function resolve_access_field_type(node: AccessNode, status: BuildStatus): Type | undefined {
	if (node.access.node_type !== "access_field") return undefined;
	const field_name = (node.access as AccessFieldNode).name;

	let base_type: Type | undefined;
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const vtype = (node.target as ValueNode).type;
		if (vtype?.name) {
			base_type = vtype;
		} else if (name === "self" && status.current_struct) {
			base_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(name)) {
			base_type = status.variable_types.get(name);
		}
	} else if (node.target.node_type === "access") {
		base_type = resolve_access_field_type(node.target as AccessNode, status);
	}

	if (!base_type?.name) return undefined;
	const struct = status.structs.find((s) => s.name === base_type!.name && !s.is_simple_type);
	const field = struct?.fields.find((f) => f.name === field_name);
	return field?.type;
}

// Emit `string.length` as a `.len` field load on the fat nomen_string
// value — O(1), no strlen. When the target is an OWNED heap string
// temporary (e.g. `Json.stringify(...).length`), the caller keeps only the
// length — wrap in a statement-expression that frees the temp's ptr after
// reading `.len`.
function emit_string_length(target: BaseNode, status: BuildStatus) {
	if (is_owned_heap_temp(target, status)) {
		const id = (status.label_counter = (status.label_counter ?? 0) + 1);
		const tmp = `_slen_${id}`;
		status.code += `({ nomen_string ${tmp} = `;
		build_node(target, status);
		status.code += `; long _slr_${id} = ${tmp}.len; free(${tmp}.ptr); _slr_${id}; })`;
		return;
	}
	status.code += "(";
	build_node(target, status);
	status.code += ").len";
}

/**
 * Resolve the type of an access-chain expression by walking through the
 * monomorphized structs (field types and method return types). Used when a
 * cached node type is stale (a generic type param like "T" that wasn't
 * substituted because it belonged to a nested generic, not the enclosing one).
 */
function resolve_access_type(node: AccessNode, status: BuildStatus): Type | null {
	const inner = node.access;

	if (inner.node_type === "access_func") {
		const access_func = inner as AccessFunctionCallNode;
		let base_type = resolve_receiver_type(node.target, status);
		if (!base_type?.name) return null;
		const mono_name = mono_type_name(base_type);
		const struct =
			status.structs.find((s) => s.name === mono_name && !s.is_generic) ||
			status.structs.find((s) => s.name === base_type!.name);
		if (!struct) return null;
		const func = struct.functions.find(
			(f) => f.name === access_func.name || f.name === `#${access_func.name}`,
		);
		return func?.return_type || null;
	}

	if (inner.node_type !== "access_field") return null;
	const field_name = (inner as AccessFieldNode).name;
	let base_type = resolve_receiver_type(node.target, status);
	if (!base_type?.name) return null;
	const struct = status.structs.find((s) => s.name === base_type!.name);
	if (!struct) return null;
	const field = struct.fields.find((f) => f.name === field_name);
	return field?.type || null;
}

function resolve_receiver_type(node: BaseNode, status: BuildStatus): Type | null {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		const vtype = (node as ValueNode).type;
		if (vtype?.name && status.structs.find((s) => s.name === vtype.name)) return vtype;
		if (name === "self" && status.current_struct) return new Type(status.current_struct.name);
		return vtype?.name ? vtype : null;
	}
	if (node.node_type === "access") {
		const resolved = resolve_access_type(node as AccessNode, status);
		if (resolved) return resolved;
		return type_from_value_node(node);
	}
	return null;
}
