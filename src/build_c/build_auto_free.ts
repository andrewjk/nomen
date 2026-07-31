import AccessNode from "../nodes/AccessNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import is_string_borrow from "./utils/is_string_borrow.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_auto_free(status: BuildStatus) {
	free_scoped_declarations(status, status.scoped_declarations);

	// Deferred reclamation: class instances displaced by variable reassignment
	// (`h = Holder(...)`) are kept alive until scope exit so borrows of the old
	// value's fields remain valid. Destroy + free them now (after the scoped
	// declarations of this scope have been processed). Mirrors aarch64's
	// anchor-slot deferred reclamation.
	if (status.deferred_frees?.length) {
		status.code += "\n// Deferred frees\n";
		for (const d of status.deferred_frees) {
			if (d.is_nullable) {
				status.code += `if (${d.temp}) { ${d.struct_name}_destroy(${d.temp}); free(${d.temp}); }\n`;
			} else {
				status.code += `${d.struct_name}_destroy(${d.temp}); free(${d.temp});\n`;
			}
		}
		status.deferred_frees.length = 0;
	}
	status.scoped_declarations = [];
}

/**
 * Emit scope-exit free/destroy code for a list of declarations. Extracted from
 * build_auto_free so that break/continue can reclaim declarations from the
 * current scope AND enclosing scopes (up to the loop body) before jumping —
 * see build_break_node. Does NOT process deferred_frees or clear the list
 * (those are scope-exit-only concerns handled by build_auto_free).
 */
export function free_scoped_declarations(status: BuildStatus, decls: DeclarationNode[]) {
	// Add dispose calls, if applicable
	// TODO: free() if it's on the heap
	let commented = false;
	for (const dec of decls) {
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
		// A `mov` field access (`var Buffer b = mov self.slots swap ...`)
		// transfers OWNERSHIP of the field's data to `b`, so `b` must be
		// destroyed at scope exit — it is NOT a non-owning view.
		const is_destructured_field_access =
			dec.value?.node_type === "access" &&
			(dec.value as AccessNode).access.node_type === "access_field" &&
			!dec.value.is_moved;
		// A string declaration initialized from an array element access
		// (`args.at(n)`, `list.first()`) is a BORROW into the container's
		// storage — including the hoisted `_param_N` temp for a call like
		// `parse_int(init.args.at(1))`. Freeing it would free argv/container
		// memory. Skip it.
		const is_borrowed_string =
			is_string_borrow(dec.value) || !!status.string_borrow_vars?.has(dec.name);
		// A string temp whose value is a fresh heap allocation (e.g. an array
		// `to_string()` hoisted as an interpolation arg) is owned and MUST be
		// freed even when its inherited type is `static` (the static-ness came
		// from the source expression, not the freshly-allocated result).
		// The C backend strdup's EVERY string return (literals, borrows, and
		// already-owned values alike — see build_return_node), so any function
		// or method call that yields a string produces a fresh heap allocation
		// the caller owns and must free.
		const value_is_heap_string =
			dec.type.name === "string" &&
			((dec.value?.node_type === "access" &&
				(dec.value as AccessNode).access.node_type === "access_func") ||
				dec.value?.node_type === "func_call");
		// A `var string x = "literal"` (or `var string x = other_owned`) is
		// strdup'd into a heap-owned copy at declaration (see
		// build_declaration_node), even though its inferred type is `static`.
		// Recompute that exact strdup condition here so the copy is freed at
		// scope exit — without also freeing genuinely static results (e.g. a
		// switch/match expression over string literals, whose non-strdup'd
		// result still points at static literal storage).
		const dec_value = dec.value as ValueNode | undefined;
		const dec_val_is_string_literal =
			dec.value?.node_type === "value" &&
			dec_value!.value.length >= 2 &&
			dec_value!.value.startsWith('"') &&
			dec_value!.value.endsWith('"');
		const dec_val_is_heap_string_var =
			dec.value?.node_type === "value" &&
			!dec_val_is_string_literal &&
			!!status.scoped_declarations.find((d) => d.name === dec_value!.value);
		const was_strdup_string_var =
			dec.declaration === "var" &&
			!dec.type.is_view &&
			!is_borrowed_string &&
			(dec_val_is_string_literal || dec_val_is_heap_string_var);
		const dec_struct = status.structs.find((s) => s.name === dec.type.name);
		const is_class_var = !!dec_struct?.is_class;
		// A trait-typed local whose concrete storage is a class holds a
		// pointer to a heap instance whose concrete type may change across
		// reassignment. Reclaim it via the trait's `<Trait>_destroy` shim
		// (dispatches through the vtable's destroy slot) then free. This
		// must precede the class_var / trait-typed-concrete branches below,
		// which would assume a fixed concrete type.
		const trait_class_trait = status.trait_class_locals?.get(dec.name);
		if (trait_class_trait !== undefined && !is_destructured_field_access) {
			if (!commented) {
				status.code += "\n// Auto-free\n";
				commented = true;
			}
			if (dec.type.is_nullable) {
				status.code += `if (${dec.name}) { ${trait_class_trait}_destroy(${dec.name}); free(${dec.name}); }\n`;
			} else {
				status.code += `${trait_class_trait}_destroy(${dec.name}); free(${dec.name});\n`;
			}
		}
		if (
			!is_destructured_field_access &&
			!is_borrowed_string &&
			(!dec.type.is_static || value_is_heap_string || was_strdup_string_var) &&
			dec.type.name === "string" &&
			!dec.type.is_array
		) {
			if (!commented) {
				status.code += "\n// Auto-free\n";
				commented = true;
			}
			status.code += `free(${dec.name});\n`;
		}
		// Class-typed variables are heap-allocated (malloc'd in the
		// constructor). Free them at scope exit. Aliases (var q = p) are
		// already excluded from scoped_declarations by build_declaration_node.
		// Nullable class vars may be null — guard with `if (x)` so a NULL
		// instance isn't passed to destroy (free(NULL) is safe but destroy
		// would dereference it).
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
			const mono_cls_name = cls ? mono_type_name(dec.type) : undefined;
			// Every class has a `<Class>_destroy` function — either a user
			// `#destroy` or an auto-generated one (build_struct_node) that
			// recursively frees owned class-typed fields. Always call it
			// before free so class fields (and their #destroy side effects)
			// are reclaimed at scope exit.
			const has_destroy_fn = !!cls?.functions.find((f) => f.name === "#destroy") || !!cls?.is_class;
			if (cls) {
				const destroy_call = has_destroy_fn ? `${mono_cls_name}_destroy(${dec.name}); ` : "";
				if (dec.type.is_nullable) {
					status.code += `if (${dec.name}) { ${destroy_call}free(${dec.name}); }\n`;
				} else {
					status.code += `${destroy_call}free(${dec.name});\n`;
				}
			} else {
				status.code += `free(${dec.name});\n`;
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
		// Trait-typed local with concrete storage (e.g.
		// `var Speaker s = Dog("Rex")`): the declared type is a trait but the
		// storage is the concrete struct (recovered from the initializer).
		// Emit destroy calls for the concrete struct — both the struct's own
		// `#destroy` (user side effects) and its owned fields (recursively via
		// emit_struct_destroys). Without this, a trait-typed local's #destroy
		// side effects were silently dropped and owned fields leaked.
		const is_trait_typed = !!status.traits.find((t) => t.name === dec.type.name);
		if (is_trait_typed && !is_destructured_field_access && !dec.type.is_array && dec.value) {
			const val_type = type_from_value_node(dec.value);
			const concrete = val_type?.name
				? status.structs.find((s) => s.name === val_type.name && !s.is_simple_type && !s.is_generic)
				: undefined;
			if (concrete && struct_needs_destroy(concrete, status)) {
				if (!commented) {
					status.code += "\n// Auto-free\n";
					commented = true;
				}
				emit_struct_destroys(status, concrete, dec.name);
			}
		}
		// Nullable struct value-type local: destroy the inner value only when
		// the companion `_has` flag is set (it may be null).
		if (
			!is_destructured_field_access &&
			!is_class_var &&
			!dec.type.is_array &&
			is_nullable_struct_type(dec.type, status)
		) {
			const inner = status.structs.find((s) => s.name === dec.type.name);
			if (inner && struct_needs_destroy(inner, status)) {
				if (!commented) {
					status.code += "\n// Auto-free\n";
					commented = true;
				}
				const body = capture_destroys(status, inner, dec.name, ".");
				status.code += `if (${has_flag_name(dec.name)}) { ${body} }\n`;
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
			const elem_is_string = elem_name === "string";
			const elem_c_type = elem_is_class ? `struct ${elem_name}*` : elem_name;
			if (elem_is_class) {
				status.code += `for (long _i = 0; _i < ${dec.name}->length; _i++) {\n`;
				status.code += `\t${elem_c_type}* _data = (${elem_c_type}*)((char*)${dec.name} + sizeof(struct Array_${elem_name}));\n`;
				status.code += `\t${elem_name}_destroy(_data[_i]); free(_data[_i]);\n`;
				status.code += `}\n`;
			} else if (elem_is_string) {
				// Function-returned string arrays strdup each element into a
				// distinct heap copy, so free every slot before the buffer.
				status.code += `for (long _i = 0; _i < ${dec.name}->length; _i++) {\n`;
				status.code += `\tchar** _data = (char**)((char*)${dec.name} + sizeof(struct Array_string));\n`;
				status.code += `\tfree(_data[_i]);\n`;
				status.code += `}\n`;
			}
			status.code += `free(${dec.name});\n`;
		}
		// Stack (fixed-size) C arrays: the backing array is not malloc'd, but
		// each element may own heap data (string / class / struct needing
		// destroy). Free each element element-by-element at scope exit. The
		// array is contiguous (`T name[N]`), so index directly into `name[_i]`
		// — no header offset like the heap Array_<T> buffer.
		if (
			!is_destructured_field_access &&
			dec.type.is_array &&
			status.stack_array_vars?.has(dec.name)
		) {
			if (!commented) {
				status.code += "\n// Auto-free\n";
				commented = true;
			}
			const elem_name = dec.type.name;
			const elem_struct = status.structs.find((s) => s.name === elem_name);
			const elem_is_class = !!elem_struct?.is_class;
			const elem_is_string = elem_name === "string";
			const elem_struct_type = status.structs.find(
				(s) => s.name === elem_name && !s.is_simple_type && !s.is_generic,
			);
			const arr_len = status.stack_array_lengths?.get(dec.name) ?? "0";
			if (elem_is_string) {
				status.code += `for (long _i = 0; _i < ${arr_len}; _i++) { free(${dec.name}[_i]); }\n`;
			} else if (elem_is_class) {
				if (has_destroy(elem_struct!)) {
					status.code += `for (long _i = 0; _i < ${arr_len}; _i++) { if (${dec.name}[_i]) { ${elem_name}_destroy(${dec.name}[_i]); free(${dec.name}[_i]); } }\n`;
				} else {
					status.code += `for (long _i = 0; _i < ${arr_len}; _i++) { free(${dec.name}[_i]); }\n`;
				}
			} else if (elem_struct_type && struct_needs_destroy(elem_struct_type, status)) {
				status.code += `for (long _i = 0; _i < ${arr_len}; _i++) {\n`;
				emit_struct_destroys(status, elem_struct_type, `${dec.name}[_i]`);
				status.code += `}\n`;
			}
		}
	}
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

/** Name-based variant of struct_needs_destroy for callers without the StructNode. */
export function struct_needs_destroy_by_name(name: string, status: BuildStatus): boolean {
	const struct = status.structs.find((s) => s.name === name && !s.is_simple_type && !s.is_generic);
	if (!struct) return false;
	return struct_needs_destroy(struct, status);
}

/**
 * Whether a struct (or any of its embedded struct fields, recursively) needs
 * a destroy call at scope exit — i.e. it has a `#destroy`, a class-typed
 * field, or a nested struct field that itself needs destroying.
 */
export function struct_needs_destroy(struct: StructNode, status: BuildStatus): boolean {
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
export function emit_struct_destroys(
	status: BuildStatus,
	struct: StructNode,
	var_expr: string,
): void {
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
				status.code += `if (${field_expr}) { ${field_struct.name}_destroy(${field_expr}); free(${field_expr}); }\n`;
			}
		} else if (is_nullable_struct_type(field.type, status)) {
			// Nullable struct field: guard on the companion `<field>_has` flag.
			if (struct_needs_destroy(field_struct, status)) {
				const body = capture_destroys(status, field_struct, field_expr, ".");
				status.code += `if (${field_expr}_has) { ${body} }\n`;
			}
		} else {
			emit_struct_destroys(status, field_struct, field_expr);
		}
	}
}

/**
 * Capture the destroy calls for a struct value as a single line (no trailing
 * newline) so it can be embedded inside an `if (...) { ... }` guard. Uses
 * `accessor` (`.` or `->`) for nested field expressions — `.` for by-value
 * locals/fields, `->` when the container is a class pointer.
 */
function capture_destroys(
	status: BuildStatus,
	struct: StructNode,
	var_expr: string,
	accessor: string,
): string {
	const before = status.code.length;
	if (has_destroy(struct)) {
		status.code += `${struct.name}_destroy(&${var_expr}); `;
	}
	for (const field of struct.fields) {
		if (field.type.is_ref) continue;
		const field_struct = resolve_struct(field.type, status);
		if (!field_struct) continue;
		const field_expr = `${var_expr}${accessor}${field.name}`;
		if (field_struct.is_class) {
			if (has_destroy(field_struct)) {
				status.code += `if (${field_expr}) { ${field_struct.name}_destroy(${field_expr}); free(${field_expr}); } `;
			}
		} else if (is_nullable_struct_type(field.type, status)) {
			if (struct_needs_destroy(field_struct, status)) {
				// Recurse into the nullable field's value, guarded by its flag.
				const inner_before = status.code.length;
				capture_destroys(status, field_struct, field_expr, accessor);
				const inner_body = status.code.substring(inner_before).trim();
				status.code = status.code.substring(0, inner_before);
				status.code += `if (${field_expr}_has) { ${inner_body} } `;
			}
		} else {
			capture_destroys(status, field_struct, field_expr, accessor);
		}
	}
	const captured = status.code.substring(before).replace(/\s+/g, " ").trim();
	status.code = status.code.substring(0, before);
	return captured;
}
