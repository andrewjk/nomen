import built_in_types from "../built_in_types.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import build_nursery_spawn from "./build_nursery_spawn.ts";
import { is_owned_heap_temp } from "./build_operation_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

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
	const before = status.code.length;
	status.suppress_dereference = true;
	build_node(target, status);
	status.suppress_dereference = false;
	const expr = status.code.substring(before);
	status.code = status.code.substring(0, before);
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
		// ref/trait/class param — emitted as `struct T *name`, already a pointer.
		if (status.function_ref_params?.has(name) || status.class_vars?.has(name)) {
			status.code += c_function_name(name);
			return;
		}
	}
	// Any other lvalue: build it without the ref-param deref and take its address.
	const before = status.code.length;
	status.suppress_dereference = true;
	build_node(node, status);
	status.suppress_dereference = false;
	const expr = status.code.substring(before);
	status.code = status.code.substring(0, before);
	status.code += "&" + expr;
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
			// Escape hatch: `nursery.spawn(fn, args...)` — emit the spawn
			// trampoline against the receiver Nursery's runtime futures/count
			// pointers. See ASYNC.md.
			if (access_func.is_nursery_spawn) {
				const nursery_ptr = nursery_pointer_expr(node.target, status);
				build_nursery_spawn(access_func, nursery_ptr, status);
				return;
			}
			// `view T` builtins operate on the universal (ptr, len) slice directly:
			//   v.at(i)       →  ((Elem*)v.ptr)[i]
			//   v.to_string() →  malloc(len+1); memcpy; null-terminate (owned copy)
			//     (to_string is string-only: it materializes a char slice.)
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
				if (access_func.name === "to_string" && target_type.name === "string") {
					// GCC statement-expression: evaluate the receiver once into a
					// temporary, then malloc/copy/null-terminate its bytes.
					const id = (status.label_counter = (status.label_counter ?? 0) + 1);
					const tmp = `_vts_${id}`;
					status.code += `({ nomen_view ${tmp} = `;
					build_node(node.target, status);
					status.code += `; char* _r = malloc(${tmp}.len + 1); memcpy(_r, ${tmp}.ptr, ${tmp}.len); _r[${tmp}.len] = 0; _r; })`;
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
			// `.to_string()` on a string-typed receiver compiles to
			// `string_to_string(receiver)`, which strdups its argument and
			// returns a fresh owned copy. When the receiver is itself an owned
			// heap temporary (e.g. a method call like `f.greet().to_string()`
			// used inside a string interpolation), the strdup'd input leaks —
			// nobody frees it. Wrap in a clang statement-expression that frees
			// the temporary after string_to_string has copied it, mirroring
			// emit_string_length.
			if (
				access_func.name === "to_string" &&
				target_type.name === "string" &&
				is_owned_heap_temp(node.target, status)
			) {
				const id = (status.label_counter = (status.label_counter ?? 0) + 1);
				const tmp = `_sts_${id}`;
				status.code += `({ char* ${tmp} = `;
				build_node(node.target, status);
				status.code += `; char* _sto_${id} = string_to_string(${tmp}); free(${tmp}); _sto_${id}; })`;
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
				status.code += `({ char* _ts_r = (char*)malloc(1); _ts_r[0] = 0; long _ts_n = 0; for (long _i = 0; _i < ${len}; _i++) { char* _s = ${to_string_fn}(`;
				if (is_heap) {
					status.code += `((${c_type(elem_name)}*)((char*)`;
					build_node(node.target, status);
					status.code += ` + sizeof(struct Array_${elem_name})))[_i]`;
				} else {
					build_node(node.target, status);
					status.code += `[_i]`;
				}
				status.code += `); _ts_n += strlen(_s); _ts_r = (char*)realloc(_ts_r, _ts_n + 1); strcat(_ts_r, _s); free(_s); } _ts_r; })`;
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

				status.code += `(${cast}_get_trait_func(`;
				build_vtable_target(node.target, status);
				status.code += `, ${trait_index}, ${func_index}))(`;

				// Receiver pointer is the first call argument only when the
				// method declares self.
				let need_comma = false;
				if (has_self) {
					build_vtable_target(node.target, status);
					need_comma = true;
				}
				for (let i = 0; i < access_func.params.length; i++) {
					if (need_comma) status.code += ", ";
					need_comma = true;
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
						const param_is_ref_param =
							!!status.function_ref_params?.has(param_value) ||
							!!status.class_vars?.has(param_value);
						if (!param_is_ref_param) {
							status.code += "&";
						} else {
							status.suppress_dereference = true;
						}
						build_node(access_func.params[i], status);
						status.suppress_dereference = false;
					} else {
						build_node(access_func.params[i], status);
					}
				}
				status.code += `)`;
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
					!status.structs.find(
						(s) =>
							s.name ===
								`${method_type!.name}_${method_type!.type_args!.map((t) => t.name).join("_")}` &&
							!s.is_generic,
					)
				) {
					const resolved = resolve_access_field_type(node.target as AccessNode, status);
					if (resolved?.name) method_type = resolved;
				}
				let mono_struct_name = method_type?.is_array
					? "Array_" + method_type.name
					: method_type?.type_args?.length
						? method_type.name + "_" + method_type.type_args.map((t) => t.name).join("_")
						: method_type?.name || "";
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
				const self_offset = target_method?.params?.some((p) => p.is_self_param) ? 1 : 0;
				// If the method doesn't exist on the struct, check if it's a
				// trait default method inherited by this struct.
				let trait_default_label = "";
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
									break;
								}
							}
						}
					}
				}
				const label =
					access_func.mangled_name ||
					trait_default_label ||
					`${mono_struct_name}_${access_func.name.replace(/#/g, "")}`;
				status.code += `${label}(`;
				if (!access_func.is_static) {
					// Emit the receiver (`self`) for a method call. A plain local
					// instance is passed by address (`&`); a pointer param/var is
					// forwarded as-is; a `ref` class param (`struct T **`) is
					// dereferenced once to yield the single pointer `self` expects.
					if (!built_in_types.includes(method_type?.name || "")) {
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
						if (!target_is_ref_param) {
							status.code += "&";
						} else if (target_is_ref_class_param) {
							// A `ref` class param is a double pointer (`struct T **`),
							// but the method's `self` is a single pointer. Leave
							// suppress_dereference off so build_value_node emits
							// `(*t)`, yielding the instance pointer self expects.
						} else {
							// target is already a pointer (var/ref param) — don't
							// dereference it; we want the pointer itself.
							status.suppress_dereference = true;
						}
					}
					build_node(node.target, status);
					status.suppress_dereference = false;
				}
				for (let i = 0; i < access_func.params.length; i++) {
					if (!access_func.is_static || i > 0) {
						status.code += ", ";
					}
					const param_type = type_from_value_node(access_func.params[i]);
					const param_value =
						access_func.params[i].node_type === "value"
							? (access_func.params[i] as ValueNode).value
							: "";
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
						build_node(access_func.params[i], status);
					}
				}
				status.code += ")";
			}
			// mov parameter handling for method calls: same as
			// build_function_call_node — remove moved class vars / temporaries
			// from scoped_declarations so they won't be double-freed.
			if (access_func.mov_param_indices) {
				for (const idx of access_func.mov_param_indices) {
					const param = access_func.params[idx];
					if (param?.node_type === "value") {
						const vname = (param as ValueNode).value;
						// A `string` arg to a `mov T` param keeps caller ownership
						// (an owning Buffer<string> strdup's its own copy), so do NOT
						// splice it — auto_free must reclaim the original. Resolve
						// the type from the declaration (a bare variable reference's
						// ValueNode.type is unset post-monomorphization).
						const di = status.scoped_declarations.findIndex((d) => d.name === vname);
						const tname =
							di !== -1
								? status.scoped_declarations[di].type?.name
								: (param as ValueNode).type?.name;
						if (tname === "string") continue;
						if (di !== -1) status.scoped_declarations.splice(di, 1);
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

// Emit `string.length` as `strlen(target)`. When the target is
// an OWNED heap string temporary (e.g. `Json.stringify(...).length`), the
// intermediate string would otherwise leak — the caller keeps only the length.
// Wrap in a clang statement-expression that frees the temp after measuring it.
function emit_string_length(target: BaseNode, status: BuildStatus) {
	if (is_owned_heap_temp(target, status)) {
		const id = (status.label_counter = (status.label_counter ?? 0) + 1);
		const tmp = `_slen_${id}`;
		status.code += `({ char* ${tmp} = `;
		build_node(target, status);
		status.code += `; long _slr_${id} = (long)strlen(${tmp}); free(${tmp}); _slr_${id}; })`;
		return;
	}
	status.code += "((long)strlen(";
	build_node(target, status);
	status.code += "))";
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
		const mono_name = base_type.type_args?.length
			? base_type.name + "_" + base_type.type_args.map((t) => t.name).join("_")
			: base_type.name;
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
