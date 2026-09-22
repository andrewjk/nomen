import {
	struct_needs_auto_destroy,
	struct_needs_destroy,
} from "../build_common/destroy_analysis.ts";
import { mono_struct_name, mono_type_name } from "../build_common/mono_name.ts";
import { has_flag_name, is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import { classify_param } from "../build_common/param_classify.ts";
import scan_force_heap_strings from "../build_common/scan_force_heap_strings.ts";
import { moved_param_is_consumed } from "../build_common/scan_moved_param_consumed.ts";
import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_extern from "./build_extern.ts";
import build_node from "./build_node.ts";
import { is_owned_heap_temp } from "./build_operation_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import { ensure_concurrency_runtime } from "./build_spawn_node.ts";
import build_struct_body from "./build_struct_body.ts";
import type BuildStatus from "./BuildStatus.ts";
import { emit_method_body_from_nir } from "./emit_nir.ts";
import c_function_name from "./utils/c_function_name.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import { begin_code_scratch, end_code_scratch } from "./utils/code_scratch.ts";
import {
	emit_owning_buffer_body,
	emit_owning_buffer_enum_body,
	emit_owning_buffer_string_body,
	emit_trivial_struct_modify_T,
	owning_buffer_element,
	owning_buffer_enum_element,
	owning_buffer_is_string_elem,
} from "./utils/owning_buffer_specialize.ts";
import scan_borrow_only_strings from "./utils/scan_borrow_only_strings.ts";

/** System types whose method bodies call into the concurrency runtime. */
const CONCURRENCY_TYPES = new Set([
	"Task",
	"Thread",
	"Fiber",
	"Channel",
	"Mutex",
	"Nursery",
	"Tcp",
]);

export default function build_struct_node(node: StructNode, status: BuildStatus) {
	if (node.is_generic) return;

	// The concurrency primitives' raw bodies branch into the runtime —
	// Fiber's statics (yield/is_fiber/set_cooperative), Task's cancel,
	// Channel's receive park/wake, Mutex's lock. Whichever of them this TU
	// compiles pulls the runtime headers in (deduped; the fiber text extends
	// POOL_HEADER). In a system-object build these bodies live in system.o
	// instead and the user TU needs nothing here.
	if (CONCURRENCY_TYPES.has(node.name)) {
		ensure_concurrency_runtime(status);
		status.used_fibers = true;
	}

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

	const custom_inits = node.functions.filter((f) => f.name === "#init" && f.has_body);
	const custom_init = custom_inits[0];

	// Classes are heap-allocated: the constructor returns a pointer and
	// mallocs the instance internally. Structs remain stack-allocated by
	// value. `accessor` picks `.` vs `->` for field writes in the body.
	const is_class = !!node.is_class;
	const accessor = is_class ? "->" : ".";

	// The constructor returns by tag (`struct Foo` / `struct Foo*`): the tag is
	// never mangled (only the typedef is), so the signature stays valid whether
	// or not a GUI build mangles the typedef name. Each `#init` overload emits
	// under its own label: mangled by param types when the struct has several,
	// the plain `<Struct>_init` otherwise.
	const ctor_return = is_class ? `struct ${node.name}*` : `struct ${node.name}`;
	const field_params = node.fields
		.filter((f) => f.value == null)
		.map((f) => {
			let decl = c_param_decl(f.type, f.name, status);
			if (is_nullable_struct_type(f.type, status)) {
				decl += `, unsigned char ${has_flag_name(f.name)}`;
			}
			return decl;
		})
		.join(", ");
	const ctor_sig = (init: FunctionNode) => {
		const ctor_params = init.params
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
			.join(", ");
		const label = is_overloaded(node, "#init")
			? mangled_label(init, node.name)
			: `${node.name}_init`;
		return `${ctor_return} ${label}(${ctor_params})`;
	};

	if (custom_init) {
		for (const ci of custom_inits) {
			status.headers += `${ctor_sig(ci)};\n`;
		}
	} else {
		status.headers += `${ctor_return} ${node.name}_init(${field_params});\n`;
	}

	if (custom_init) {
		for (const custom_init of custom_inits) {
			// Custom init — generate a constructor function with the user-facing
			// signature (no self param). Inside, create a local `self` struct,
			// run the init body (which assigns fields via `self.field = ...`),
			// then return it.
			status.code += `${ctor_sig(custom_init)}\n{\n`;
			if (is_class) {
				status.code += `struct ${node.name}* self = malloc(sizeof(struct ${node.name}));\n`;
			} else {
				status.code += `struct ${node.name} self;\n`;
			}
			if (node.traits.length) {
				status.code += `self${accessor}_vt = &_${node.name}_traits;\n`;
			}

			// Track which `self.<field>`s hold a real value while the init body
			// runs. The instance is a fresh `malloc` — fields start as garbage,
			// so the FIRST body write to a field must skip the displaced-value
			// reclaim. Defaulted fields (seeded below) hold a real value before
			// the body, so their first write reclaims the default normally.
			const old_init_assigned_fields = status.init_assigned_fields;
			status.init_assigned_fields = new Set();

			// Apply default field values BEFORE the custom init body runs, so any
			// field the init doesn't explicitly assign still gets its default.
			// A defaulted field holds a REAL value before the body — record it
			// as already-assigned so the body's first write reclaims the
			// default instead of skipping (only truly uninitialized fields
			// start as garbage).
			for (const field of node.fields) {
				if (field.value) {
					status.init_assigned_fields?.add(`self.${field.name}`);
					if (
						field.type.is_view &&
						!field.type.is_array &&
						!is_nullable_struct_type(field.type, status)
					) {
						// Defaulted view field (see the auto-init loop): borrow the
						// string literal's storage, or zero the pair.
						if (field.type.name === "string") {
							status.code += `{ nomen_string _p = `;
							build_node(field.value, status);
							status.code += `; self${accessor}${field.name} = (nomen_view){ _p.ptr, _p.len }; }\n`;
						} else {
							status.code += `self${accessor}${field.name} = (nomen_view){0};\n`;
						}
					} else if (is_nullable_struct_type(field.type, status)) {
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
						// A class's plain string field is always heap-owned (the
						// init body's reassignment `free(self->field.ptr)` and
						// <Class>_destroy free it unconditionally), so a default
						// must be duplicated — a raw literal here would be freed
						// as static rodata. A heap-producing default is stored
						// directly. Value structs keep the raw store (their
						// field ownership is tracked per assignment).
						const field_is_class_string =
							is_class &&
							field.type.name === "string" &&
							!field.type.is_array &&
							!field.type.is_ref &&
							!field.type.is_view;
						const value_is_fresh_heap =
							!!field.value && is_owned_heap_temp(field.value as BaseNode, status);
						const wrap_dup = field_is_class_string && !value_is_fresh_heap;
						// A literal `null` default zero-initializes the string
						// field's pair — for a class OR a value struct. A bare
						// `0` (or nomen_str_dup(0)) would be a C type error, and
						// a NULL `.ptr` keeps the destroy-side free a no-op.
						const default_is_null =
							field.type.name === "string" &&
							!field.type.is_array &&
							!field.type.is_ref &&
							!field.type.is_view &&
							field.value.node_type === "value" &&
							(field.value as ValueNode).value === "null";
						status.code += `self${accessor}${field.name} = `;
						if (default_is_null) {
							status.code += `(nomen_string){0, 0}`;
						} else {
							if (wrap_dup) {
								status.code += `nomen_str_dup(`;
							}
							build_node(field.value, status);
							if (wrap_dup) {
								status.code += `)`;
							}
						}
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
			const old_current_function = status.current_function;
			status.function_ref_params = new Set<string>();
			status.class_vars = new Set<string>();
			status.function_variadic_params = new Set<string>();
			status.self_is_ref = is_class;
			status.self_is_local = !is_class;
			status.current_struct = node;
			status.current_function = custom_init;
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
			// Raw blocks inside a custom init see the same fat ABI as everywhere
			// else (see docs/MEMORY.md) — no thin aliases, no text rewriting.
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
			status.current_function = old_current_function;
			status.init_assigned_fields = old_init_assigned_fields;
			status.function_return_type = old_return_type;
		}

		// Build all other struct functions (skip #init — handled above)
		build_struct_functions(node, status, true);
	} else {
		// Auto-generated init. The local instance variable must not collide
		// with any field parameter (params are derived from field names), or
		// the local shadows the param and the field self-assigns garbage
		// (e.g. `struct Big { var int b }` → `Big b; … b.b = b;`). `_self`
		// matches the convention used by the method-build path above.
		const object_name = "_self";
		status.code += `${ctor_return} ${node.name}_init(${field_params})\n{\n`;
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
			if (
				field.type.is_view &&
				!field.type.is_array &&
				!is_nullable_struct_type(field.type, status)
			) {
				// A `view T` field: a REQUIRED field copies its (ptr, len)
				// param verbatim; a defaulted one borrows the default's
				// storage (a string literal wraps its fat value into the pair
				// form) or zeroes the pair. Nothing is duplicated — views are
				// borrows.
				if (!field.value) {
					status.code += `${object_name}${accessor}${field.name} = ${field.name};\n`;
				} else if (field.type.name === "string") {
					status.code += `{ nomen_string _p = `;
					build_node(field.value, status);
					status.code += `; ${object_name}${accessor}${field.name} = (nomen_view){ _p.ptr, _p.len }; }\n`;
				} else {
					status.code += `${object_name}${accessor}${field.name} = (nomen_view){0};\n`;
				}
			} else if (field.type.storage_kind === "stack_array" && field.type.length) {
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
			} else if (
				!field.type.is_ref &&
				!field.type.is_view &&
				status.enums.find((e) => e.name === field.type.name && e.has_associated_data)
			) {
				// Enum-with-data field: take an OWNING copy of the incoming
				// blob (the helper strdups the active case's string payloads)
				// so the field's payloads are independent of the expression
				// temp — which may be reclaimed at its own scope exit.
				const field_enum_name = field.type.name;
				if (!field.value) {
					// Enum params pass BY VALUE (a tagged-union struct) — no
					// pointer dereference, unlike struct params.
					status.code += `${object_name}${accessor}${field.name} = ${field_enum_name}_copy(${field.name});\n`;
				} else {
					status.code += `${object_name}${accessor}${field.name} = ${field_enum_name}_copy(`;
					build_node(field.value, status);
					status.code += `);\n`;
				}
			} else {
				// A class's plain string field is always heap-owned (freed
				// unconditionally by <Class>_destroy): strdup the default /
				// param value — it may be a static literal or a borrow. A
				// heap-producing default (is_owned_heap_temp) is stored
				// directly. Value structs keep the raw store (their field
				// ownership is tracked per assignment / by Buffer stores).
				// A `view T` field is a non-owning pair — stored raw, never
				// duplicated.
				const field_is_class_string =
					is_class &&
					field.type.name === "string" &&
					!field.type.is_array &&
					!field.type.is_ref &&
					!field.type.is_view;
				const value_is_fresh_heap =
					!!field.value && is_owned_heap_temp(field.value as BaseNode, status);
				const wrap_strdup = field_is_class_string && !value_is_fresh_heap;
				// A literal `null` default zero-initializes the string field's
				// pair — for a class OR a value struct. A bare `0` (or
				// nomen_str_dup(0)) would be a C type error, and a NULL `.ptr`
				// keeps the destroy-side free a no-op.
				const default_is_null =
					!!field.value &&
					field.type.name === "string" &&
					!field.type.is_array &&
					!field.type.is_ref &&
					!field.type.is_view &&
					field.value.node_type === "value" &&
					(field.value as ValueNode).value === "null";
				status.code += `${object_name}${accessor}${field.name} = `;
				if (default_is_null) {
					status.code += `(nomen_string){0, 0}`;
				} else if (wrap_strdup && !field.value) {
					// A class string field param is normally strdup'd (the
					// field is heap-owned and freed unconditionally at
					// destroy) — but a `null` argument has a NULL `.ptr`, and
					// nomen_str_dup strlens it. Guard on the ptr: a null pair
					// stores raw (free(NULL) is a no-op).
					status.code += `${field.name}.ptr ? nomen_str_dup(${field.name}) : ${field.name}`;
				} else {
					if (wrap_strdup) {
						status.code += `nomen_str_dup(`;
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
						if (wrap) status.code += "nomen_str_dup(";
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
	// A `view T` parameter is the universal non-owning (ptr, len) slice
	// struct, passed by value (mirrors build_parameter_node and the aarch64
	// register-pair convention).
	if (type.is_view) {
		return `nomen_view ${name}`;
	}
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
		// The #spawn construction marker (ASYNC_PLAN phase 3): the
		// construction is compiler-generated (build_magic_ctor); the member
		// itself is a declaration and never emits.
		if (func.name === "#spawn") {
			continue;
		}
		if (func.name === "#init" && !func.has_body) {
			continue;
		}
		if (func.name === "#init" && skip_init) {
			continue;
		}
		if (func.is_extern) {
			build_extern(func, status, node);
			continue;
		}

		const old_ref_params = status.function_ref_params;
		const old_self_is_ref = status.self_is_ref;
		const old_class_vars = status.class_vars;
		const old_ref_class_params = status.ref_class_params;
		const old_ref_class_param_types = status.ref_class_param_types;
		const old_scoped_declarations = status.scoped_declarations;
		const old_borrow_only = status.c_borrow_only_strings;
		const old_force_heap = status.force_heap_strings;
		const old_heap_array_vars = status.heap_array_vars;
		status.heap_array_vars = undefined;
		const old_stack_array_lengths = status.stack_array_lengths;
		status.stack_array_lengths = undefined;
		const old_return_type = status.function_return_type;
		const old_function_name = status.current_function_name;
		const old_current_function = status.current_function;
		status.current_function = func;
		const old_view_params = status.function_view_params;
		status.function_view_params = new Set<string>();
		status.current_function_name = func.name;
		status.function_ref_params = new Set<string>();
		status.class_vars = new Set<string>();
		status.ref_class_params = new Set<string>();
		status.ref_class_param_types = new Map();
		status.scoped_declarations = enter_c_scope(status);
		status.c_borrow_only_strings = scan_borrow_only_strings(func);
		// Shared with the aarch64 backend (see build_function_node): force
		// heap ownership for string vars that receive a heap value later.
		status.force_heap_strings = scan_force_heap_strings(func.statements ?? [], status.structs);
		status.function_return_type = func.return_type;
		const self_param = func.params[0]?.is_self_param ? func.params[0] : null;
		status.self_is_ref = !!self_param?.is_ref || self_param?.declaration === "var";
		// Raw blocks see fat strings directly: bodies access a C `char*`
		// via the explicit `.ptr` half — in T-generic container monos the
		// checker's T substitution already wrote nomen_string-typed bodies.
		// No shims, no thin ABI (see docs/MEMORY.md).
		for (let param of func.params) {
			// A `view T` param lowers to a by-value nomen_view — record its
			// name so call sites / declarations inside this body recognize
			// bare uses as view VALUES (no owned→view re-wrap).
			if (param.type.is_view && !param.is_self_param) {
				status.function_view_params.add(c_function_name(param.name));
			}
			const param_struct = status.structs.find((s) => s.name === param.type.name);
			const param_trait = status.traits.find((t) => t.name === param.type.name);
			// Only struct/trait/self/ref params and non-simple `var` params are
			// emitted as pointers (see build_parameter_node). A `var int x` is
			// by-value, so it must NOT be in function_ref_params. A method of
			// a SIMPLE-TYPE struct (int/uint/bool/char/floats) also receives
			// `self` by value (c_type spelling, no struct tag), so its self
			// must not be dereferenced at use sites either.
			const is_pointer_param =
				(param.is_self_param && !node.is_simple_type) ||
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

		// A `move` class param transfers ownership to the callee — register it
		// as a scoped declaration so build_auto_free destroys+frees it at the
		// method's exit, mirroring build_function_node (and skipping params
		// whose ownership escapes into an outliving value — the same
		// consumed-scan the top-level path uses).
		for (const param of func.params) {
			if (param.is_self_param) continue;
			const param_struct = status.structs.find((s) => s.name === param.type.name);
			if (
				param.is_moved &&
				param_struct?.is_class &&
				!moved_param_is_consumed(func, param.name, param_struct.name, status.structs)
			) {
				const pname = c_function_name(param.name);
				status.scoped_declarations.push(
					new DeclarationNode(param.start, "private", "move", pname, param.type),
				);
			}
		}

		// Define the function
		// HACK: Need to map names to types
		// Raw `#arch: c` bodies see fat `nomen_string` values directly —
		// the function emits under its REAL label with its fat signature,
		// and a C `char*` is an explicit `.ptr` (see docs/MEMORY.md).
		// The signature builds into a scratch buffer so its text can be
		// copied to the header without a substring of (and a full-rope
		// flatten of) the accumulated code — see code_scratch.ts. The
		// buffer-swap inside (build_struct_body writing the header) composes:
		// it round-trips the scratch string through status.headers.
		const saved_sig = begin_code_scratch(status);
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
		const emit_label = func_label_name;
		if (func.return_type.is_array) {
			// Returning array data pointer (e.g. out Array<T> becomes T[] after monomorphization)
			// The #arch: c block returns void* containing struct header + data
			status.code += `void* ${emit_label}(`;
		} else if (returns_array_data) {
			// Returning Array<T> data — use T* (e.g. with returns int*)
			const elem_type = c_type(func.return_type.type_args![0].name);
			status.code += `${elem_type}* ${emit_label}(`;
		} else if (return_type.startsWith("Array_")) {
			// Array struct types (e.g. Array_int) return void* (pointer to heap buffer
			// with header + data layout). The #arch: c block allocates the buffer.
			status.code += `void* ${emit_label}(`;
		} else if (func.return_type.is_view) {
			// A `view T` return is a non-owning (ptr, len) slice returned by
			// value. Every view lowers to the universal nomen_view struct.
			status.code += `nomen_view ${emit_label}(`;
		} else {
			// Monomorphize generic container returns (`out List<VLine>` →
			// `struct List_VLine`) — the bare generic has no emitted body,
			// so a bare `struct List` return is an incomplete type. No-op
			// for non-generic returns. Mirrors build_function_node.
			const mono_return_type = mono_type_name(func.return_type);
			const return_struct = status.structs.find(
				(s) => s.name === mono_return_type && !s.is_simple_type,
			);
			const return_trait = status.traits.find((t) => t.name === mono_return_type);
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
				status.code += `struct ${mono_return_type}`;
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
			status.code += ` ${emit_label}(`;
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
		const signature = end_code_scratch(status, saved_sig);
		status.code += signature;
		status.headers += `${signature};\n`;

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
		const owning_enum = owning_buffer_enum_element(node, status);
		const specialized =
			(owning_enum && emit_owning_buffer_enum_body(func.name, owning_enum, status)) ||
			(owning_elem && emit_owning_buffer_body(func.name, owning_elem, status)) ||
			(owning_buffer_is_string_elem(node) && emit_owning_buffer_string_body(func.name, status)) ||
			(func.name === "modify" && emit_trivial_struct_modify_T(node, status));
		if (!specialized) {
			emit_method_body_from_nir(func, status);
		}
		// A user `#destroy` on a CLASS must still free the class's plain
		// string fields after the body — they are always heap-owned (`_init`
		// strdup's defaults/args, assignments strdup non-heap RHS), so not
		// freeing them leaks. Mirrors build_auto_destroy and the aarch64
		// backend's build_destroy_function (emit_field_destroys).
		if (func.name === "#destroy" && node.is_class) {
			for (const field of node.fields) {
				if (field.type.is_ref || field.type.is_array || field.type.is_view) continue;
				if (field.type.name === "string") {
					status.code += `free(self->${field.name}.ptr);\n`;
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
		status.force_heap_strings = old_force_heap;
		status.heap_array_vars = old_heap_array_vars;
		status.stack_array_lengths = old_stack_array_lengths;
		status.function_return_type = old_return_type;
		status.current_function_name = old_function_name;
		status.current_function = old_current_function;
		status.function_view_params = old_view_params;
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
			// A `view T` trait field accessor passes the (ptr, len) pair by
			// value — the universal nomen_view form, not the element type.
			const field_c_type = field_type.is_view
				? "nomen_view"
				: field_is_struct
					? `struct ${field_type.name}`
					: c_type(field_type.name);
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
		// A `view T` field is a non-owning borrow: freeing its pointer half
		// would be an invalid free (the storage is owned elsewhere).
		if (field.type.is_view) continue;
		// An enum-with-data field owns its ACTIVE case's payloads (case
		// construction strdups string args / transfers reference pointers,
		// and every enum-field store takes owning copies via <Enum>_copy).
		const field_enum =
			!field.type.is_array && !field.type.is_view
				? status.enums.find((e) => e.name === field.type.name && e.has_associated_data)
				: undefined;
		if (field_enum) {
			status.code += `${field_enum.name}_free_payloads(&self->${field.name});\n`;
			continue;
		}
		// A `string` field owns heap memory: for VALUE structs the Buffer
		// per-element destroy path frees slots strdup'd by store_T; for
		// CLASSES the field is always heap-owned (`_init` strdup's defaults,
		// assignments strdup non-heap RHS), so the destroy frees it too.
		if (field.type.name === "string" && !field.type.is_array && !field.type.is_view) {
			status.code += `free(self->${field.name}.ptr);\n`;
			continue;
		}
		// A func-typed field of a CLASS may hold a capturing closure (a heap
		// env + descriptor, `owned = 1`) — reclaim it with the same
		// free-if-owned arm a func-typed local uses. VALUE-struct func fields
		// stay non-owning (struct copies share the descriptor; the existing
		// non-owning copy contract), so this arm is class-only
		// (CLOSURE.md Phase 2c).
		if (field.type.name === "func" && node.is_class) {
			const f = `((struct nomen_closure *)self->${field.name})`;
			status.code += `if (${f} && ${f}->owned) { if (${f}->destroy_env) ${f}->destroy_env(${f}->env); free(${f}->env); free(${f}); }\n`;
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
			// the instance is freshly owned, e.g. `Holder(move Box(7))`), or
			// (b) the field is declared `move` — then the field is the sole
			// owner of its instance (ownership transferred at assignment time in
			// build_assignment_node, which removes the source from
			// scoped_declarations). Recursively destroy + free so subtrees
			// deeper than one level are reclaimed (mirrors aarch64's
			// emit_field_destroys). Nullable fields may be null, so guard the
			// destroy/free with `if`. Non-`move` class fields without a
			// `#destroy` frequently alias another owned variable and are left
			// to leak rather than risk a double-free.
			const field_has_destroy = !!field_struct.functions.find((f) => f.name === "#destroy");
			const field_is_owned = field.declaration === "move";
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
