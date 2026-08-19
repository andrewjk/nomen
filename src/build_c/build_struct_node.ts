import {
	struct_needs_auto_destroy,
	struct_needs_destroy,
} from "../build_common/destroy_analysis.ts";
import { mono_struct_name, mono_type_name } from "../build_common/mono_name.ts";
import { classify_param } from "../build_common/param_classify.ts";
import { moved_param_is_consumed } from "../build_common/scan_moved_param_consumed.ts";
import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import { is_owned_heap_temp } from "./build_operation_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import build_struct_body from "./build_struct_body.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";
import {
	emit_owning_buffer_body,
	emit_owning_buffer_string_body,
	owning_buffer_element,
	owning_buffer_is_string_elem,
} from "./utils/owning_buffer_specialize.ts";
import scan_borrow_only_strings from "./utils/scan_borrow_only_strings.ts";

export default function build_struct_node(node: StructNode, status: BuildStatus) {
	if (node.is_generic) return;

	// If it's an inbuilt type, only build its functions
	// That way we can add e.g. traits like Stringable to ints
	if (node.is_simple_type) {
		status.code += `// Struct ${node.name}\n`;
		build_struct_functions(node, status);
		status.code += "\n";
		return;
	}

	// TODO: Only if top-level
	status.headers += `// Struct ${node.name}\n`;
	status.code += `// Struct ${node.name}\n`;

	if (node.traits.length) {
		build_struct_traits(node, status);
	}

	// Struct body (typedef) was already emitted by build_struct_body in the first pass.
	// We just need to emit the forward declaration to headers here.
	status.headers += `struct ${node.name};\n`;

	const custom_init = node.functions.find((f) => f.name === "#init" && f.has_body);

	// Classes are heap-allocated: the constructor returns a pointer and
	// mallocs the instance internally. Structs remain stack-allocated by
	// value. `accessor` picks `.` vs `->` for field writes in the body.
	const is_class = !!node.is_class;
	const accessor = is_class ? "->" : ".";

	// Declare the constructor
	const ctor_params = custom_init
		? custom_init.params
				.filter((p) => !p.is_self_param)
				.map((p) => {
					// Variadic params are emitted as `long _name_len, T *name`
					// (mirroring build_function_node), so the body can read
					// `name[i]` and `_name_len`.
					let decl = "";
					if (p.is_variadic) {
						decl += `long _${p.name}_len, `;
					}
					decl += c_param_decl(p.type, p.name, status, {
						is_ref: p.is_ref || p.type.is_ref,
						declaration: p.declaration,
					});
					// A nullable struct value param (`T? f`, T a non-class
					// struct) takes a companion `unsigned char <name>_has`
					// flag as the very next C parameter (mirrors
					// build_function_node). The constructor body reads the
					// flag through the param name directly.
					if (!p.is_variadic && is_nullable_struct_type(p.type, status)) {
						decl += `, unsigned char ${has_flag_name(p.name)}`;
					}
					return decl;
				})
				.join(", ")
		: node.fields
				.filter((f) => f.value == null)
				.map((f) => {
					let decl = c_param_decl(f.type, f.name, status);
					if (is_nullable_struct_type(f.type, status)) {
						decl += `, unsigned char ${has_flag_name(f.name)}`;
					}
					return decl;
				})
				.join(", ");
	// The constructor returns by tag (`struct Foo` / `struct Foo*`): the tag is
	// never mangled (only the typedef is), so the signature stays valid whether
	// or not a GUI build mangles the typedef name. The forward declaration
	// below used to prepend `struct ` to a bare-name return; with the tag
	// baked in here it's emitted as-is.
	const ctor_return = is_class ? `struct ${node.name}*` : `struct ${node.name}`;
	const ctor = `${ctor_return} ${node.name}_init(${ctor_params})`;
	status.headers += `${ctor};\n`;

	if (custom_init) {
		// Custom init — generate a constructor function with the user-facing
		// signature (no self param). Inside, create a local `self` struct,
		// run the init body (which assigns fields via `self.field = ...`),
		// then return it.
		status.code += `${ctor}\n{\n`;
		if (is_class) {
			status.code += `struct ${node.name}* self = malloc(sizeof(struct ${node.name}));\n`;
		} else {
			status.code += `struct ${node.name} self;\n`;
		}
		if (node.traits.length) {
			status.code += `self${accessor}_vt = &_${node.name}_traits;\n`;
		}

		// Apply default field values BEFORE the custom init body runs, so any
		// field the init doesn't explicitly assign still gets its default.
		for (const field of node.fields) {
			if (field.value) {
				if (is_nullable_struct_type(field.type, status)) {
					// Default is either `null` (flag 0, value untouched) or a
					// struct value (copy it in, flag 1).
					const is_null =
						field.value.node_type === "value" && (field.value as any).value === "null";
					if (is_null) {
						status.code += `self${accessor}${has_flag_name(field.name)} = 0;\n`;
					} else {
						status.code += `self${accessor}${field.name} = `;
						build_node(field.value, status);
						status.code += `;\nself${accessor}${has_flag_name(field.name)} = 1;\n`;
					}
				} else {
					status.code += `self${accessor}${field.name} = `;
					build_node(field.value, status);
					status.code += ";\n";
				}
			}
		}

		// Build the custom init body. For structs, `self` is a local by-value
		// variable (self_is_local=true, field access uses `.`). For classes,
		// `self` is a heap pointer (self_is_local=false, self_is_ref=true,
		// field access uses `->`).
		const old_ref_params = status.function_ref_params;
		const old_class_vars = status.class_vars;
		const old_self_is_ref = status.self_is_ref;
		const old_self_is_local = status.self_is_local;
		const old_current_struct = status.current_struct;
		const old_return_type = status.function_return_type;
		const old_variadic_params = status.function_variadic_params;
		status.function_ref_params = new Set<string>();
		status.class_vars = new Set<string>();
		status.function_variadic_params = new Set<string>();
		status.self_is_ref = is_class;
		status.self_is_local = !is_class;
		status.current_struct = node;
		status.function_return_type = custom_init.return_type;
		for (const p of custom_init.params) {
			if (p.is_variadic) {
				status.function_variadic_params!.add(c_function_name(p.name));
			}
			// Register a `ref` init param so body uses dereference it,
			// matching the pointer the signature (classify_param) now emits.
			// Class/trait-typed params follow the method loop's convention
			// (class_vars — the pointer IS the value); primitives go through
			// function_ref_params like a `ref` param of any free function.
			if (!p.is_self_param && (p.is_ref || p.type.is_ref)) {
				const pname = c_function_name(p.name);
				const p_struct = status.structs.find((s) => s.name === p.type.name);
				const p_trait = status.traits.find((t) => t.name === p.type.name);
				if (p_struct?.is_class || p_trait) {
					status.class_vars!.add(pname);
				} else {
					status.function_ref_params!.add(pname);
				}
			}
		}
		for (let child of custom_init.statements) {
			build_node(child, status, true);
		}
		status.code += `return self;\n`;
		status.code += `}\n`;
		status.function_ref_params = old_ref_params;
		status.class_vars = old_class_vars;
		status.function_variadic_params = old_variadic_params;
		status.self_is_ref = old_self_is_ref;
		status.self_is_local = old_self_is_local;
		status.current_struct = old_current_struct;
		status.function_return_type = old_return_type;

		// Build all other struct functions (skip #init — handled above)
		build_struct_functions(node, status, true);
	} else {
		// Auto-generated init. The local instance variable must not collide
		// with any field parameter (params are derived from field names), or
		// the local shadows the param and the field self-assigns garbage
		// (e.g. `struct Big { var int b }` → `Big b; … b.b = b;`). `_self`
		// matches the convention used by the method-build path above.
		const object_name = "_self";
		status.code += `${ctor}\n{\n`;
		if (is_class) {
			status.code += `struct ${node.name}* ${object_name} = malloc(sizeof(struct ${node.name}));\n`;
		} else {
			status.code += `struct ${node.name} ${object_name};\n`;
		}
		if (node.traits.length) {
			status.code += `${object_name}${accessor}_vt = &_${node.name}_traits;\n`;
		}
		// Fields from the struct
		for (const field of node.fields) {
			if (field.type.storage_kind === "stack_array" && field.type.length) {
				// Fixed-size stack array fields — use memcpy instead of assignment
				status.code += `memcpy(${object_name}${accessor}${field.name}, ${field.name}, sizeof(${object_name}${accessor}${field.name}));\n`;
			} else if (is_nullable_struct_type(field.type, status) && field.value) {
				// Nullable struct field with a default (typically `= null`).
				const is_null = field.value.node_type === "value" && (field.value as any).value === "null";
				if (is_null) {
					status.code += `${object_name}${accessor}${has_flag_name(field.name)} = 0;\n`;
				} else {
					status.code += `${object_name}${accessor}${field.name} = `;
					build_node(field.value, status);
					status.code += `;\n${object_name}${accessor}${has_flag_name(field.name)} = 1;\n`;
				}
			} else if (is_nullable_struct_type(field.type, status)) {
				// Nullable struct field WITHOUT a default: copy the value from
				// the param and forward the companion flag (the call site
				// passed `<field>_has` as a sibling C parameter).
				status.code += `${object_name}${accessor}${field.name} = *${field.name};\n`;
				status.code += `${object_name}${accessor}${has_flag_name(field.name)} = ${has_flag_name(field.name)};\n`;
			} else {
				// A class's plain string field is always heap-owned (freed
				// unconditionally by <Class>_destroy): strdup the default /
				// param value — it may be a static literal or a borrow. A
				// heap-producing default (is_owned_heap_temp) is stored
				// directly. Value structs keep the raw store (their field
				// ownership is tracked per assignment / by Buffer stores).
				const field_is_class_string =
					is_class && field.type.name === "string" && !field.type.is_array && !field.type.is_ref;
				const value_is_fresh_heap =
					!!field.value && is_owned_heap_temp(field.value as BaseNode, status);
				const wrap_strdup = field_is_class_string && !value_is_fresh_heap;
				status.code += `${object_name}${accessor}${field.name} = `;
				if (wrap_strdup) {
					status.code += `strdup(`;
				}
				if (field.value) {
					build_node(field.value, status);
				} else {
					// Struct params are passed by pointer — dereference when
					// assigning into a by-value field. Class fields are now
					// pointers themselves, so don't dereference the param.
					// Resolve a generic field type (e.g. `List<int>`) to its
					// mono struct so the pointer/value decision matches the
					// (already monomorphized) ctor signature.
					const field_struct = status.structs.find(
						(s) => s.name === mono_struct_name(field.type, status) && !s.is_simple_type,
					);
					const field_trait = status.traits.find((t) => t.name === field.type.name);
					if ((field_struct && !field_struct.is_class) || field_trait) {
						status.code += `*`;
					}
					status.code += field.name;
				}
				if (wrap_strdup) {
					status.code += `)`;
				}
				status.code += ";\n";
			}
		}
		// Default fields from traits
		for (let traitName of node.traits) {
			const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
			if (trait) {
				for (let field of trait.fields.filter(
					(f) => !node.fields.find((nf) => nf.name === f.name),
				)) {
					// TODO: Set the value properly
					status.code += `${object_name}${accessor}${field.name}`;
					if (field.value) {
						status.code += " = ";
						// A class's trait-default string field is heap-owned
						// (see the field loop above).
						const wrap =
							is_class &&
							field.type.name === "string" &&
							!field.type.is_array &&
							!field.type.is_ref &&
							!is_owned_heap_temp(field.value as BaseNode, status);
						if (wrap) status.code += "strdup(";
						build_node(field.value, status);
						if (wrap) status.code += ")";
					}
					status.code += ";\n";
				}
			}
		}
		status.code += `return ${object_name};\n`;
		status.code += `}\n`;

		build_struct_functions(node, status);
	}

	// Classes without a custom #destroy need an auto-generated X_destroy
	// function so that ClassBuffer<T>'s raw C block (which calls T_destroy)
	// can link. The function recursively destroys class-typed fields, then
	// returns — the caller (e.g. ClassBuffer) calls free() afterwards.
	if (is_class && !node.functions.find((f) => f.name === "#destroy")) {
		build_auto_destroy(node, status);
	} else if (
		!is_class &&
		!node.functions.find((f) => f.name === "#destroy") &&
		struct_needs_auto_destroy(node, status)
	) {
		// A value struct that owns heap data through its fields (e.g.
		// `struct Person { var string name }`) needs an auto-generated
		// <Struct>_destroy: Buffer<T> calls T_destroy per element when T is
		// an owning value struct (per-element destroy on replace / scope
		// exit), and trait-conforming owning value structs dispatch destroy
		// through the vtable when boxed into ClassBuffer<Trait>. Without
		// this, owning value struct elements in containers would leak their
		// string/class fields.
		build_auto_destroy(node, status);
	}

	status.headers += "\n";
	status.code += "\n";
}

function build_struct_traits(node: StructNode, status: BuildStatus) {
	// Build the per-trait function-pointer tables (one entry per trait method —
	// the struct's override if present, else the trait's default body — then a
	// get/set pair per trait field).
	for (let traitName of node.traits) {
		// E.g. int* _Dog_Animal_vtable_[4];
		status.code += `void *_${node.name}_${traitName}_funcs[] = {`;
		const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
		status.code += trait.functions
			.map(
				(f) =>
					`${node.functions.find((tf) => tf.name === f.name) !== undefined ? node.name : trait.name}_${f.name}`,
			)
			.join(", ");
		if (trait.functions.length && trait.fields.length) {
			status.code += ", ";
		}
		status.code += trait.fields
			.map((f) => `get_${node.name}_${f.name}, set_${node.name}_${f.name}`)
			.join(", ");
		status.code += `};\n`;
	}

	// Per-struct destroy function-pointer table, or NULL if the struct has
	// no destroy function. Slot [0] of _<Struct>_traits (below) holds the
	// address of this table (or NULL); a trait-typed collection
	// (ClassBuffer<Trait>) dispatches destroy polymorphically by loading
	// [obj] → [vtable, #0] → [destroy_funcs, #0] → the concrete destroy.
	// This is independent of which trait the collection is typed by — every
	// trait-conforming struct has the same vtable prefix layout. The destroy
	// fn exists when the struct has a user #destroy, is a class
	// (auto-destroy), or owns heap data through its fields (auto-destroy).
	// For structs without any of these, the slot is NULL and the
	// dispatcher's NULL check short-circuits. (Non-trait owning value
	// structs also get a standalone destroy fn from build_auto_destroy, but
	// don't need the vtable — Buffer calls it directly.)
	const has_destroy_fn =
		!!node.functions.find((f) => f.name === "#destroy") ||
		!!node.is_class ||
		(node.traits.length > 0 && struct_needs_destroy(node, status));
	if (has_destroy_fn) {
		const destroy_label = `${node.name}_destroy`;
		status.headers += `void ${destroy_label}(struct ${node.name} *);\n`;
		status.code += `void *_${node.name}_destroy_funcs[] = {${destroy_label}};\n`;
	}
	const destroy_slot = has_destroy_fn ? `&_${node.name}_destroy_funcs` : `NULL`;

	// Build the vtable that points to the above table by index. The destroy
	// slot at index 0 is present (NULL when the struct has no destroy); real
	// trait tables follow at indices 1..traits.length, so _get_trait_func
	// shifts trait_index by 1 to skip the destroy slot.
	// E.g. void *_Dog_traits[] = {&_Dog_destroy_funcs, NULL, NULL, &_<...>_funcs};
	status.code += `void *_${node.name}_traits[] = {`;
	status.code += [destroy_slot]
		.concat(
			status.traits.map((t) => {
				if (node.traits.includes(t.name)) {
					return `&_${node.name}_${t.name}_funcs`;
				} else {
					return "NULL";
				}
			}),
		)
		.join(", ");
	status.code += `};\n`;
}

/**
 * Build a C parameter declaration as a string (type + name), applying the same
 * `struct` prefix and pointer rules as build_parameter_node. Used where the
 * signature needs to be captured as a string (e.g. constructor declarations)
 * rather than emitted directly to status.code. Classification is shared via
 * classify_param; flags are optional because the field-derived auto-init form
 * carries none (fields cannot be `ref`, and their params default to `const`).
 */
function c_param_decl(
	type: Type,
	name: string,
	status: BuildStatus,
	flags?: { is_ref?: boolean; declaration?: string },
): string {
	// A heap `Array<T>` param is a `struct Array_<T>*` (the value owns a heap
	// buffer with a length header), not a raw element pointer.
	if (type.storage_kind === "heap_array") {
		return `struct Array_${type.name} *${name}`;
	}
	// A generic field type applied to concrete args (e.g. `List<int>`) lowers
	// to its monomorphized struct (`struct List_int *`) — the bare generic
	// has no emitted body, so a `struct List *` param would be an incomplete
	// type and the field assignment a type conflict. Mirrors the mono rewrite
	// in build_parameter_node for free-function params.
	const type_name = mono_struct_name(type, status);
	const cls = classify_param(type, type_name, flags ?? {}, status);
	let out = "";
	// Struct/trait params use the `struct Tag` form (the tag is never mangled,
	// only the typedef is) — emit the plain name, not c_type's typedef.
	if (cls.is_struct) {
		out += `struct ${type_name}`;
	} else {
		out += c_type(type_name);
	}
	if (cls.wants_pointer) {
		out += ` *`;
	} else {
		out += ` `;
	}
	out += name;
	return out;
}

function build_struct_functions(node: StructNode, status: BuildStatus, skip_init = false) {
	// Build the struct's functions
	const old_current_struct = status.current_struct;
	status.current_struct = node;
	for (let func of node.functions) {
		if (func.name === "#init" && !func.has_body) {
			continue;
		}
		if (func.name === "#init" && skip_init) {
			continue;
		}

		const old_ref_params = status.function_ref_params;
		const old_self_is_ref = status.self_is_ref;
		const old_class_vars = status.class_vars;
		const old_ref_class_params = status.ref_class_params;
		const old_ref_class_param_types = status.ref_class_param_types;
		const old_scoped_declarations = status.scoped_declarations;
		const old_borrow_only = status.c_borrow_only_strings;
		const old_return_type = status.function_return_type;
		const old_function_name = status.current_function_name;
		status.current_function_name = func.name;
		status.function_ref_params = new Set<string>();
		status.class_vars = new Set<string>();
		status.ref_class_params = new Set<string>();
		status.ref_class_param_types = new Map();
		status.scoped_declarations = enter_c_scope(status);
		status.c_borrow_only_strings = scan_borrow_only_strings(func);
		status.function_return_type = func.return_type;
		const self_param = func.params[0]?.is_self_param ? func.params[0] : null;
		status.self_is_ref = !!self_param?.is_ref || self_param?.declaration === "var";
		for (let param of func.params) {
			const param_struct = status.structs.find((s) => s.name === param.type.name);
			const param_trait = status.traits.find((t) => t.name === param.type.name);
			// Only struct/trait/self/ref params and non-simple `var` params are
			// emitted as pointers (see build_parameter_node). A `var int x` is
			// by-value, so it must NOT be in function_ref_params.
			const is_pointer_param =
				param.is_self_param ||
				(param_struct && !param_struct.is_simple_type) ||
				param_trait ||
				param.is_ref ||
				param.type.is_ref ||
				(param.declaration === "var" && param_struct && !param_struct.is_simple_type);
			if (is_pointer_param) {
				const pname = c_function_name(param.name);
				if (param_struct?.is_class || param_trait) {
					// Class params AND trait-typed params are pointers but must
					// NOT be dereferenced at value-use sites — the pointer IS
					// the value. A trait-typed param is a pointer to a
					// heap-allocated, vtable-bearing struct (a class instance
					// or a boxed value struct), so `value` (not `*value`)
					// flows into raw `T`-typed slots like Buffer.store_int.
					// Track them in class_vars instead of function_ref_params.
					status.class_vars.add(pname);
					// A `ref` class param is emitted as a double pointer
					// (`struct T **`), mirroring top-level functions. Track it
					// so use sites dereference once (`(*name)`) and call sites
					// forward the double pointer as-is to another ref param.
					if (
						param_struct?.is_class &&
						(param.is_ref || param.type.is_ref) &&
						!param.is_self_param
					) {
						status.ref_class_params.add(pname);
						status.ref_class_param_types!.set(pname, param.type);
					}
				} else {
					status.function_ref_params.add(pname);
				}
			}
		}

		// A `mov` class param transfers ownership to the callee — register it
		// as a scoped declaration so build_auto_free destroys+frees it at the
		// method's exit, mirroring build_function_node (and skipping params
		// whose ownership escapes into an outliving value — the same
		// consumed-scan the top-level path uses).
		for (const param of func.params) {
			if (param.is_self_param) continue;
			const param_struct = status.structs.find((s) => s.name === param.type.name);
			if (param.is_moved && param_struct?.is_class && !moved_param_is_consumed(func, param.name)) {
				const pname = c_function_name(param.name);
				status.scoped_declarations.push(
					new DeclarationNode(param.start, "private", "mov", pname, param.type),
				);
			}
		}

		// Define the function
		// HACK: Need to map names to types
		const func_start = status.code.length;
		let return_type = func.return_type.name || "void";
		// For methods of specialized generic structs (e.g. Array_int),
		// replace generic return type (e.g. Array) with the specialized name
		// so downstream checks can detect array return types.
		if (return_type !== node.name && node.name.startsWith(return_type + "_")) {
			return_type = node.name;
		}
		const returns_array_data =
			(func.return_type.type_args?.length ?? 0) > 0 && return_type === "Array";
		const func_label_name = is_overloaded(node, func.name)
			? mangled_label(func, node.name)
			: `${node.name}_${func.name.replace(/#/g, "")}`;
		if (func.return_type.is_array) {
			// Returning array data pointer (e.g. out Array<T> becomes T[] after monomorphization)
			// The #arch: c block returns void* containing struct header + data
			status.code += `void* ${func_label_name}(`;
		} else if (returns_array_data) {
			// Returning Array<T> data — use T* (e.g. with returns int*)
			const elem_type = c_type(func.return_type.type_args![0].name);
			status.code += `${elem_type}* ${func_label_name}(`;
		} else if (return_type.startsWith("Array_")) {
			// Array struct types (e.g. Array_int) return void* (pointer to heap buffer
			// with header + data layout). The #arch: c block allocates the buffer.
			status.code += `void* ${func_label_name}(`;
		} else if (func.return_type.is_view) {
			// A `view T` return is a non-owning (ptr, len) slice returned by
			// value. Every view lowers to the universal nomen_view struct.
			status.code += `nomen_view ${func_label_name}(`;
		} else {
			const return_struct = status.structs.find((s) => s.name === return_type && !s.is_simple_type);
			const return_trait = status.traits.find((t) => t.name === return_type);
			// A method that RETURNS a value struct by value needs that struct's
			// full typedef at its signature. The signature is forward-declared
			// in the HEADER, but only `struct T;` lives there — so emit the
			// full typedef to the header on demand. The `emitted_struct_bodies`
			// guard makes this a one-time emission (the late code-body pass then
			// no-ops), avoiding a redefinition. Buffer-swap so build_struct_body
			// (which writes status.code) appends to the header instead.
			if (return_struct && !return_struct.is_class) {
				const swap = status.code;
				status.code = status.headers;
				build_struct_body(return_struct, status);
				status.headers = status.code;
				status.code = swap;
			}
			// A struct/trait return uses the `struct Tag` form (tag never
			// mangled); otherwise emit the typedef/primitive via c_type.
			if (return_struct || return_trait) {
				status.code += `struct ${return_type}`;
			} else {
				status.code += `${c_type(return_type)}`;
			}
			// Class return types are pointers (heap-allocated). Trait-typed
			// return types are also pointers — every trait-typed value in a
			// monomorphized container context (e.g. `T List_T_at(...)`) is a
			// pointer to a heap-allocated, vtable-bearing struct (a class
			// instance or a boxed value struct). Emitting the bare typedef
			// would treat it as a value type, which can't be initialised from
			// `0L` (null) or from `load_int()`'s long return.
			if (return_struct?.is_class || return_trait) {
				status.code += `*`;
			}
			status.code += ` ${func_label_name}(`;
		}
		for (let i = 0; i < func.params.length; i++) {
			if (i > 0) {
				status.code += ", ";
			}
			build_parameter_node(func.params[i], status);
		}
		status.code += `)`;

		// Emit forward declarations for any struct types referenced in the
		// function signature that haven't been declared yet. This handles
		// cases where a monomorphized container (e.g. List_Animal) references
		// a user-defined class (e.g. Animal) that is nested inside main and
		// hasn't been forward-declared at this point in the header.
		forward_decl_referenced_types(func, status);

		// TODO: Only if top-level
		status.headers += `${status.code.substring(func_start)};\n`;

		status.code += `\n{\n`;

		// HACK: Dereference the `self` pointer arg to a local variable with a random name
		// (`_self` for now, but we could automate it)
		// Skip for `ref self` and `ref self` — mutations should propagate through the pointer directly
		if (
			!node.is_simple_type &&
			func.params[0]?.is_self_param &&
			!func.params[0]?.is_ref &&
			func.params[0]?.declaration !== "var"
		) {
			status.code += `struct ${node.name} _self = *self;\n`;
			if (!status.variable_types) status.variable_types = new Map();
			status.variable_types.set("_self", new Type(node.name));
			status.variable_types.set("self", new Type(node.name));
		}
		// If this Buffer_<T> method targets an owning element type — a value
		// struct with string/nested-owning fields, OR a `string` primitive —
		// emit a specialized body (deep-copy on store, per-element destroy)
		// instead of the raw primitive block. The raw block assumes trivially
		// destructible elements and would leak/double-free owning fields.
		const owning_elem = owning_buffer_element(node, status);
		const specialized =
			(owning_elem && emit_owning_buffer_body(func.name, owning_elem, status)) ||
			(owning_buffer_is_string_elem(node) && emit_owning_buffer_string_body(func.name, status));
		if (!specialized) {
			for (let child of func.statements) {
				build_node(child, status, true);
			}
		}
		// A user `#destroy` on a CLASS must still free the class's plain
		// string fields after the body — they are always heap-owned (`_init`
		// strdup's defaults/args, assignments strdup non-heap RHS), so not
		// freeing them leaks. Mirrors build_auto_destroy and the aarch64
		// backend's build_destroy_function (emit_field_destroys).
		if (func.name === "#destroy" && node.is_class) {
			for (const field of node.fields) {
				if (field.type.is_ref || field.type.is_array) continue;
				if (field.type.name === "string") {
					status.code += `free(self->${field.name});\n`;
				}
			}
		}
		// Always run auto_free at function exit (see build_function_node): a
		// conditional early return still falls through, and those fall-through
		// declarations must be reclaimed.
		build_auto_free(status);
		status.code += `}\n`;
		status.function_ref_params = old_ref_params;
		status.class_vars = old_class_vars;
		status.ref_class_params = old_ref_class_params;
		status.ref_class_param_types = old_ref_class_param_types;
		status.self_is_ref = old_self_is_ref;
		leave_c_scope(status);
		status.scoped_declarations = old_scoped_declarations;
		status.c_borrow_only_strings = old_borrow_only;
		status.function_return_type = old_return_type;
		status.current_function_name = old_function_name;
	}
	status.current_struct = old_current_struct;

	// Build functions to get and set the trait's fields
	// TODO: Maybe this would be better done with a map?
	for (let traitName of node.traits) {
		const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
		for (let field of trait.fields) {
			// A generic trait's field type is an unresolved type param (e.g.
			// `T`); the conforming struct redeclares the field with the concrete
			// type, so prefer the struct's own field type for the accessor
			// signature. Falls back to the trait field for non-generic traits
			// whose conformer may inherit the field.
			const own_field = node.fields.find((nf) => nf.name === field.name);
			const field_type = own_field ? own_field.type : field.type;
			// A struct field type needs the `struct` tag in C (e.g. `struct Point`,
			// not `Point`); scalar/string fields lower via c_type directly. This
			// matters for multi-word struct trait fields, which are returned/passed
			// by value through the get/set accessors. The tag (plain name) is never
			// mangled — only the typedef is — so emit it directly for the struct
			// case rather than `struct ` + c_type (which would mangle the tag).
			const field_is_struct = !!status.structs.find(
				(s) => s.name === field_type.name && !s.is_simple_type,
			);
			const field_c_type = field_is_struct ? `struct ${field_type.name}` : c_type(field_type.name);
			const get_signature = `${field_c_type} get_${node.name}_${field.name}(struct ${node.name} *self)`;
			status.headers += `${get_signature};\n`;
			status.code += `${get_signature} { return self->${field.name}; }\n`;
			const set_signature = `void set_${node.name}_${field.name}(struct ${node.name} *self, ${field_c_type} value)`;
			status.headers += `${set_signature};\n`;
			status.code += `${set_signature} { self->${field.name} = value; }\n`;
		}
	}
}

function build_auto_destroy(node: StructNode, status: BuildStatus) {
	const func_label = `${node.name}_destroy`;
	const sig = `void ${func_label}(struct ${node.name} *self)`;
	status.headers += `${sig};\n`;
	status.code += `${sig}\n{\n`;
	for (const field of node.fields) {
		if (field.type.is_ref) continue;
		// A `string` field owns heap memory: for VALUE structs the Buffer
		// per-element destroy path frees slots strdup'd by store_T; for
		// CLASSES the field is always heap-owned (`_init` strdup's defaults,
		// assignments strdup non-heap RHS), so the destroy frees it too.
		if (field.type.name === "string" && !field.type.is_array) {
			status.code += `free(self->${field.name});\n`;
			continue;
		}
		// Resolve the MONOMORPHIZED struct for a generic field type (e.g.
		// `Map<int,int>` → `Map_int_int`), so the destroy call matches the
		// actual field type — `Map_destroy` doesn't exist.
		const mono_name = mono_type_name(field.type);
		const field_struct = status.structs.find((s) => s.name === mono_name && !s.is_simple_type);
		if (!field_struct) continue;
		if (field_struct.is_class) {
			// Reclaim an owned class-typed field when either (a) its type has
			// a user-defined `#destroy` (so its observable side effects run, and
			// the instance is freshly owned, e.g. `Holder(mov Box(7))`), or
			// (b) the field is declared `mov` — then the field is the sole
			// owner of its instance (ownership transferred at assignment time in
			// build_assignment_node, which removes the source from
			// scoped_declarations). Recursively destroy + free so subtrees
			// deeper than one level are reclaimed (mirrors aarch64's
			// emit_field_destroys). Nullable fields may be null, so guard the
			// destroy/free with `if`. Non-`mov` class fields without a
			// `#destroy` frequently alias another owned variable and are left
			// to leak rather than risk a double-free.
			const field_has_destroy = !!field_struct.functions.find((f) => f.name === "#destroy");
			const field_is_owned = field.declaration === "mov";
			if (field_has_destroy) {
				status.code += `if (self->${field.name}) {\n`;
				status.code += `${field_struct.name}_destroy(self->${field.name});\n`;
				status.code += `free(self->${field.name});\n`;
				status.code += `}\n`;
			} else if (field_is_owned) {
				if (field.type.is_nullable) {
					status.code += `if (self->${field.name}) {\n`;
					status.code += `${field_struct.name}_destroy(self->${field.name});\n`;
					status.code += `free(self->${field.name});\n`;
					status.code += `}\n`;
				} else {
					status.code += `${field_struct.name}_destroy(self->${field.name});\n`;
					status.code += `free(self->${field.name});\n`;
				}
			}
		} else if (field_struct.functions.find((f) => f.name === "#destroy")) {
			status.code += `${field_struct.name}_destroy(&self->${field.name});\n`;
		} else if (struct_needs_destroy(field_struct, status)) {
			// A nested value struct whose owning fields (string, class, ...)
			// trigger an auto-generated destroy. Call it to recursively free
			// owned resources.
			status.code += `${field_struct.name}_destroy(&self->${field.name});\n`;
		}
	}
	status.code += `}\n`;
}

function forward_decl_referenced_types(func: FunctionNode, status: BuildStatus) {
	const types_to_decl = new Set<string>();
	if (func.return_type.name) {
		const mono_name = mono_type_name(func.return_type);
		if (status.structs.find((s) => s.name === mono_name && !s.is_simple_type)) {
			types_to_decl.add(mono_name);
		}
	}
	for (const param of func.params) {
		if (param.is_self_param) continue;
		if (status.structs.find((s) => s.name === param.type.name && !s.is_simple_type)) {
			types_to_decl.add(param.type.name);
		}
	}
	for (const name of types_to_decl) {
		status.headers += `struct ${name};\n`;
	}
}
