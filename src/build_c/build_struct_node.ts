import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";
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
					decl += c_param_decl(p.type, p.name, status);
					return decl;
				})
				.join(", ")
		: node.fields
				.filter((f) => f.value == null)
				.map((f) => c_param_decl(f.type, f.name, status))
				.join(", ");
	const ctor_return = is_class ? `${node.name}*` : node.name;
	const ctor = `${ctor_return} ${node.name}_init(${ctor_params})`;
	status.headers += `struct ${ctor};\n`;

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
		const old_self_is_ref = status.self_is_ref;
		const old_self_is_local = status.self_is_local;
		const old_current_struct = status.current_struct;
		const old_return_type = status.function_return_type;
		const old_variadic_params = status.function_variadic_params;
		status.function_ref_params = new Set<string>();
		status.function_variadic_params = new Set<string>();
		status.self_is_ref = is_class;
		status.self_is_local = !is_class;
		status.current_struct = node;
		status.function_return_type = custom_init.return_type;
		for (const p of custom_init.params) {
			if (p.is_variadic) {
				status.function_variadic_params!.add(c_function_name(p.name));
			}
		}
		for (let child of custom_init.statements) {
			build_node(child, status, true);
		}
		status.code += `return self;\n`;
		status.code += `}\n`;
		status.function_ref_params = old_ref_params;
		status.function_variadic_params = old_variadic_params;
		status.self_is_ref = old_self_is_ref;
		status.self_is_local = old_self_is_local;
		status.current_struct = old_current_struct;
		status.function_return_type = old_return_type;

		// Build all other struct functions (skip #init — handled above)
		build_struct_functions(node, status, true);
	} else {
		// Auto-generated init
		const object_name = node.name.substring(0, 1).toLocaleLowerCase();
		status.code += `${ctor}\n{\n`;
		if (is_class) {
			status.code += `struct ${node.name}* ${object_name} = malloc(sizeof(struct ${node.name}));\n`;
		} else {
			status.code += `${node.name} ${object_name};\n`;
		}
		if (node.traits.length) {
			status.code += `${object_name}${accessor}_vt = &_${node.name}_traits;\n`;
		}
		// Fields from the struct
		for (const field of node.fields) {
			if (field.type.is_array && field.type.length) {
				// Fixed-size array fields — use memcpy instead of assignment
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
			} else {
				status.code += `${object_name}${accessor}${field.name} = `;
				if (field.value) {
					build_node(field.value, status);
				} else {
					// Struct params are passed by pointer — dereference when
					// assigning into a by-value field. Class fields are now
					// pointers themselves, so don't dereference the param.
					const field_struct = status.structs.find(
						(s) => s.name === field.type.name && !s.is_simple_type,
					);
					const field_trait = status.traits.find((t) => t.name === field.type.name);
					if ((field_struct && !field_struct.is_class) || field_trait) {
						status.code += `*`;
					}
					status.code += field.name;
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
						build_node(field.value, status);
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
	}

	status.headers += "\n";
	status.code += "\n";
}

function build_struct_traits(node: StructNode, status: BuildStatus) {
	// Build the vtable that points to the struct's traits' methods by index
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

	// Build the vtable that points to the above table by index
	// E.g. int* _Dog_vtable_[];
	status.code += `void *_${node.name}_traits[] = {`;
	status.code += status.traits
		.map((t) => {
			if (node.traits.includes(t.name)) {
				return `&_${node.name}_${t.name}_funcs`;
			} else {
				return "NULL";
			}
		})
		.join(", ");
	status.code += `};\n`;
}

/**
 * Build a C parameter declaration as a string (type + name), applying the same
 * `struct` prefix and pointer rules as build_parameter_node. Used where the
 * signature needs to be captured as a string (e.g. constructor declarations)
 * rather than emitted directly to status.code.
 */
function c_param_decl(type: Type, name: string, status: BuildStatus): string {
	const struct_type = status.structs.find((s) => s.name === type.name);
	const trait_type = status.traits.find((t) => t.name === type.name);
	const is_struct = !!struct_type && !struct_type.is_simple_type;
	const is_simple = !!struct_type?.is_simple_type;
	const is_ptr = type.is_array || (!is_simple && (is_struct || !!trait_type));
	let out = "";
	if (is_struct || trait_type) {
		out += `struct `;
	}
	out += c_type(type.name);
	if (is_ptr) {
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
		const old_scoped_declarations = status.scoped_declarations;
		const old_borrow_only = status.c_borrow_only_strings;
		const old_return_type = status.function_return_type;
		status.function_ref_params = new Set<string>();
		status.class_vars = new Set<string>();
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
				if (param_struct?.is_class) {
					// Class params are pointers but must NOT be dereferenced at
					// value-use sites (the pointer IS the value). Track them in
					// class_vars instead of function_ref_params.
					status.class_vars.add(pname);
				} else {
					status.function_ref_params.add(pname);
				}
			}
		}

		// Define the function
		// HACK: Need to map names to types
		const func_start = status.code.length;
		let return_type = func.return_type.name || "void";
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
		} else {
			// HACK: For methods of specialized generic structs (e.g. Array_int),
			// replace generic return type (e.g. Array) with the specialized name
			if (return_type !== node.name && node.name.startsWith(return_type + "_")) {
				return_type = node.name;
			}
			const return_struct = status.structs.find((s) => s.name === return_type && !s.is_simple_type);
			if (return_struct) {
				status.code += `struct `;
			}
			status.code += `${c_type(return_type)}`;
			// Class return types are pointers (heap-allocated)
			if (return_struct?.is_class) {
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
		// Skip for `ref self` and `var self` — mutations should propagate through the pointer directly
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
		for (let child of func.statements) {
			build_node(child, status, true);
		}
		// Always run auto_free at function exit (see build_function_node): a
		// conditional early return still falls through, and those fall-through
		// declarations must be reclaimed.
		build_auto_free(status);
		status.code += `}\n`;
		status.function_ref_params = old_ref_params;
		status.class_vars = old_class_vars;
		status.self_is_ref = old_self_is_ref;
		leave_c_scope(status);
		status.scoped_declarations = old_scoped_declarations;
		status.c_borrow_only_strings = old_borrow_only;
		status.function_return_type = old_return_type;
	}
	status.current_struct = old_current_struct;

	// Build functions to get and set the trait's fields
	// TODO: Maybe this would be better done with a map?
	for (let traitName of node.traits) {
		const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
		for (let field of trait.fields) {
			const get_signature = `${c_type(field.type.name)} get_${node.name}_${field.name}(struct ${node.name} *self)`;
			status.headers += `${get_signature};\n`;
			status.code += `${get_signature} { return self->${field.name}; }\n`;
			const set_signature = `void set_${node.name}_${field.name}(struct ${node.name} *self, ${c_type(field.type.name)} value)`;
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
		const field_struct = status.structs.find(
			(s) => s.name === field.type.name && !s.is_simple_type,
		);
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
		}
	}
	status.code += `}\n`;
}

function forward_decl_referenced_types(func: FunctionNode, status: BuildStatus) {
	const types_to_decl = new Set<string>();
	if (func.return_type.name) {
		const mono_name = func.return_type.type_args?.length
			? `${func.return_type.name}_${func.return_type.type_args.map((t: Type) => t.name).join("_")}`
			: func.return_type.name;
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
