import AccessNode from "../nodes/AccessNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_auto_free(status: BuildStatus) {
	// Add dispose calls, if applicable
	// TODO: free() if it's on the heap
	let commented = false;
	for (const dec of status.scoped_declarations) {
		// Call dispose() if it has the Disposable trait
		const struct = status.structs.find((s) => s.name === dec.type.name);
		if (struct && struct.traits.includes("Disposable")) {
			const trait = status.traits.find((t) => t.name === "Disposable");
			const func = trait?.functions.find((f) => f.name == "dispose");
			if (trait && func) {
				if (!commented) {
					status.code += "\n// Auto-free\n";
					commented = true;
				}
				const cast = "(void *(*)(void *))";
				const traitIndex = status.traits.indexOf(trait);
				const funcIndex = trait.functions.indexOf(func);
				status.code += `(${cast}_get_trait_func((void *)&${dec.name}, ${traitIndex}, ${funcIndex}))(&${dec.name});\n`;
			}
		}

		// Free its memory
		// TODO: Also if it's a struct etc
		// Skip variables produced by tuple destructuring (`var [a, b] = expr`):
		// each destructured name is a field access (`expr._i`) of a temporary
		// tuple, so its ownership is ambiguous — the field may be a borrowed
		// pointer (e.g. a string literal stored in the tuple) that must not be
		// freed. The temporary owns the tuple's contents; the destructured
		// bindings are non-owning views.
		const is_destructured_field_access =
			dec.value?.node_type === "access" &&
			(dec.value as AccessNode).access.node_type === "access_field";
		const dec_struct = status.structs.find((s) => s.name === dec.type.name);
		const is_class_var = !!dec_struct?.is_class;
		if (
			!is_destructured_field_access &&
			!dec.type.is_static &&
			dec.type.name === "string" &&
			!dec.type.is_array
		) {
			if (!commented) {
				status.code += "\n// Auto-free\n";
				commented = true;
			}
			status.code += `free(${dec.name});\n`;
			status.code += `malloc_count--;\n`;
		}
		// Class-typed variables are heap-allocated (malloc'd in the
		// constructor). Free them at scope exit. Aliases (var q = p) are
		// already excluded from scoped_declarations by build_declaration_node.
		// Nullable class vars may be null — guard with `if (x)` so we don't
		// decrement malloc_count for a NULL free (free(NULL) is safe but
		// the count would go negative).
		// Every class has a `<Class>_destroy` function — either a user-defined
		// `#destroy` or an auto-generated one (see build_struct_node) that
		// recursively frees owned class-typed fields. Always call it before
		// free so that class fields (and their #destroy side effects) are
		// reclaimed at scope exit.
		if (!is_destructured_field_access && is_class_var && !dec.type.is_array) {
			if (!commented) {
				status.code += "\n// Auto-free\n";
				commented = true;
			}
			const cls = struct ?? dec_struct;
			if (cls) {
				const destroy_call = `${cls.name}_destroy(${dec.name}); `;
				if (dec.type.is_nullable) {
					status.code += `if (${dec.name}) { ${destroy_call}free(${dec.name}); malloc_count--; }\n`;
				} else {
					status.code += `${destroy_call}free(${dec.name});\n`;
					status.code += `malloc_count--;\n`;
				}
			} else {
				status.code += `free(${dec.name});\n`;
				status.code += `malloc_count--;\n`;
			}
		}
		// Struct-typed variables (non-class, non-array, non-string) that own
		// heap data through their fields — e.g. `List<T>` embeds a
		// `ClassBuffer<T>` (or `Buffer<T>`) whose `#destroy` frees the backing
		// store and any stored class elements. Walk the struct's fields and
		// emit destroy calls for any field whose type has a `#destroy` (or is
		// a class). Mirrors aarch64's `emit_destroy_for_decl` +
		// `emit_field_destroys`. The struct's own `#destroy` (if any) runs
		// first (user side effects), then each field's destroy is called.
		if (
			!is_destructured_field_access &&
			!is_class_var &&
			!dec.type.is_array &&
			dec.type.name !== "string"
		) {
			const mono_name = mono_type_name(dec.type);
			const struct_type = status.structs.find(
				(s) => s.name === mono_name && !s.is_simple_type && !s.is_generic,
			);
			if (struct_type && struct_needs_destroy(struct_type, status)) {
				if (!commented) {
					status.code += "\n// Auto-free\n";
					commented = true;
				}
				emit_struct_destroys(status, struct_type, dec.name);
			}
		}
		// Heap-allocated arrays (returned from functions / Array.with): free
		// each class element (destroy + free), then free the buffer itself.
		// Stack arrays (from literals) are NOT freed here — they're not malloc'd.
		if (
			!is_destructured_field_access &&
			dec.type.is_array &&
			status.heap_array_vars?.has(dec.name)
		) {
			if (!commented) {
				status.code += "\n// Auto-free\n";
				commented = true;
			}
			const elem_name = dec.type.name;
			const elem_struct = status.structs.find((s) => s.name === elem_name);
			const elem_is_class = !!elem_struct?.is_class;
			const elem_c_type = elem_is_class ? `struct ${elem_name}*` : elem_name;
			if (elem_is_class) {
				status.code += `for (long _i = 0; _i < ${dec.name}->length; _i++) {\n`;
				status.code += `\t${elem_c_type}* _data = (${elem_c_type}*)((char*)${dec.name} + sizeof(struct Array_${elem_name}));\n`;
				status.code += `\t${elem_name}_destroy(_data[_i]); free(_data[_i]);\n`;
				status.code += `}\n`;
			}
			status.code += `free(${dec.name});\n`;
			status.code += `malloc_count--;\n`;
		}
	}
	// Deferred reclamation: class instances displaced by variable reassignment
	// (`h = Holder(...)`) are kept alive until scope exit so borrows of the old
	// value's fields remain valid. Destroy + free them now (after the scoped
	// declarations of this scope have been processed). Mirrors aarch64's
	// anchor-slot deferred reclamation.
	if (status.deferred_frees?.length) {
		if (!commented) {
			status.code += "\n// Deferred frees\n";
		}
		for (const d of status.deferred_frees) {
			if (d.is_nullable) {
				status.code += `if (${d.temp}) { ${d.struct_name}_destroy(${d.temp}); free(${d.temp}); malloc_count--; }\n`;
			} else {
				status.code += `${d.struct_name}_destroy(${d.temp}); free(${d.temp}); malloc_count--;\n`;
			}
		}
		status.deferred_frees.length = 0;
	}
	status.scoped_declarations.length = 0;
}

function mono_type_name(type: Type): string {
	return type.type_args?.length
		? `${type.name}_${type.type_args.map((t) => t.name).join("_")}`
		: type.name;
}

function resolve_struct(type: Type, status: BuildStatus): StructNode | undefined {
	const mono_name = mono_type_name(type);
	return status.structs.find((s) => s.name === mono_name && !s.is_simple_type && !s.is_generic);
}

function has_destroy(struct: StructNode): boolean {
	return !!struct.functions.find((f) => f.name === "#destroy");
}

/**
 * Whether a struct (or any of its embedded struct fields, recursively) needs
 * a destroy call at scope exit — i.e. it has a `#destroy`, a class-typed
 * field, or a nested struct field that itself needs destroying.
 */
function struct_needs_destroy(struct: StructNode, status: BuildStatus): boolean {
	if (has_destroy(struct)) return true;
	for (const field of struct.fields) {
		if (field.type.is_ref) continue;
		const field_struct = resolve_struct(field.type, status);
		if (!field_struct) continue;
		if (field_struct.is_class) return true;
		if (struct_needs_destroy(field_struct, status)) return true;
	}
	return false;
}

/**
 * Emit destroy calls for a struct variable at scope exit. Calls the struct's
 * own `#destroy` first (if any), then walks each field: class-typed fields
 * are destroyed + freed (pointer); nested struct fields are recursively
 * destroyed via their own `#destroy`. Mirrors aarch64's
 * `emit_destroy_for_decl` + `emit_field_destroys`.
 */
function emit_struct_destroys(status: BuildStatus, struct: StructNode, var_expr: string): void {
	if (has_destroy(struct)) {
		status.code += `${struct.name}_destroy(&${var_expr});\n`;
	}
	for (const field of struct.fields) {
		if (field.type.is_ref) continue;
		const field_struct = resolve_struct(field.type, status);
		if (!field_struct) continue;
		const field_expr = `${var_expr}.${field.name}`;
		if (field_struct.is_class) {
			if (has_destroy(field_struct)) {
				status.code += `if (${field_expr}) { ${field_struct.name}_destroy(${field_expr}); free(${field_expr}); malloc_count--; }\n`;
			}
		} else {
			emit_struct_destroys(status, field_struct, field_expr);
		}
	}
}
