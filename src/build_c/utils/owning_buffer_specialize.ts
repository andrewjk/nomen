import StructNode from "../../nodes/StructNode.ts";
import { struct_needs_destroy } from "../build_auto_free.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Detect whether a monomorphized struct is a `Buffer_<T>` whose element type
 * `T` is a value struct that owns heap data (string fields, owning nested
 * struct fields). Buffer<T> for such elements cannot use the plain
 * shallow-copy primitives (store_T/replace_T/#destroy) — the slot and the
 * source would share owned pointers, so per-element destroy would double-free
 * and omitting it leaks. Instead, the build emits specialized bodies:
 *
 *  - store_T: shallow-copy + strdup per string field (slot owns its copies).
 *  - replace_T: destroy old slot value + shallow-copy + strdup per string.
 *  - #destroy: per-element T_destroy + free slab.
 *
 * Class/trait elements route to ClassBuffer (which handles per-element
 * destroy/frees soundly); trivially-destructible value structs (no owning
 * fields) use the plain Buffer primitives unchanged.
 */
export function owning_buffer_element(
	node: StructNode,
	status: BuildStatus,
): StructNode | undefined {
	if (!node.name.startsWith("Buffer_")) return undefined;
	const elem_name = node.name.substring("Buffer_".length);
	const elem = status.structs.find(
		(s) => s.name === elem_name && !s.is_simple_type && !s.is_generic,
	);
	if (!elem || elem.is_class) return undefined;
	// Only own-string-field value structs need specialization. A struct with
	// only class fields would already route to ClassBuffer; a struct with no
	// owning fields (trivially destructible) uses the plain primitives.
	if (!has_owning_fields(elem, status)) return undefined;
	return elem;
}

function has_owning_fields(node: StructNode, status: BuildStatus): boolean {
	return struct_needs_destroy(node, status);
}

/**
 * The names of Buffer methods that get specialized for owning value structs.
 * load_T and move_T are NOT specialized: load_T returns a shallow copy (a
 * borrow — the caller's struct local is not destroyed, so no double-free);
 * move_T transfers ownership (the slot is zeroed, the caller takes the
 * pointers).
 */
export const OWNING_BUFFER_METHODS = new Set(["store_T", "replace_T", "destroy"]);

/**
 * Emit a specialized C body for a Buffer method whose element type is an
 * owning value struct. Returns true if the body was emitted (the caller
 * should skip the raw block); false if the raw block should be used as-is.
 *
 * The signature + opening brace + _self deref have already been emitted by
 * build_struct_functions; this function only emits the body statements.
 */
export function emit_owning_buffer_body(
	func_name: string,
	elem: StructNode,
	status: BuildStatus,
): boolean {
	if (!OWNING_BUFFER_METHODS.has(func_name)) return false;

	const Tptr = `struct ${elem.name} *`;
	const Tcast = `(struct ${elem.name} *)`;

	if (func_name === "store_T") {
		// store_T(self, i, val): shallow-copy the struct into the slot, then
		// strdup each string field so the slot owns an independent copy.
		status.code += `${Tptr}_slots = ${Tcast}(unsigned long long)self->data;\n`;
		status.code += `_slots[i] = (*val);\n`;
		emit_deep_copy_fields(elem, "_slots[i]", "val", status);
		return true;
	}

	if (func_name === "replace_T") {
		// replace_T(self, i, val): destroy the old slot value (it owned
		// heap memory), then shallow-copy + strdup the new value.
		status.code += `${Tptr}_slots = ${Tcast}(unsigned long long)self->data;\n`;
		status.code += `${elem.name}_destroy(&_slots[i]);\n`;
		status.code += `_slots[i] = (*val);\n`;
		emit_deep_copy_fields(elem, "_slots[i]", "val", status);
		return true;
	}

	if (func_name === "destroy") {
		// #destroy(self): per-element T_destroy, then free the slab.
		status.code += `if (self->data) {\n`;
		status.code += `${Tptr}_slots = ${Tcast}(unsigned long long)self->data;\n`;
		status.code += `for (int _i = 0; _i < self->cap; _i++) {\n`;
		status.code += `${elem.name}_destroy(&_slots[_i]);\n`;
		status.code += `}\n`;
		status.code += `free(_slots);\n`;
		status.code += `}\n`;
		status.code += `self->data = 0;\n`;
		status.code += `self->cap = 0;\n`;
		return true;
	}

	return false;
}

/**
 * For each string field on the element struct, overwrite the shallow-copied
 * pointer in `dst` with a fresh strdup of `src`'s field. This breaks the
 * pointer aliasing between the source and the slot so each can be destroyed
 * independently. For nested owning value struct fields, recursively call the
 * nested struct's destroy + deep-copy (the nested destroy frees the
 * shallow-copied owned sub-fields, then the deep-copy re-strdup's them).
 */
function emit_deep_copy_fields(
	elem: StructNode,
	dst: string,
	src: string,
	status: BuildStatus,
): void {
	for (const field of elem.fields) {
		if (field.type.is_ref) continue;
		if (field.type.name === "string" && !field.type.is_array) {
			// strdup the source's string into the destination slot so the
			// slot owns an independent heap copy.
			status.code += `${dst}.${field.name} = strdup(${src}${arrow(src)}${field.name});\n`;
		} else if (field.type.name && !field.type.is_array) {
			const field_struct = status.structs.find(
				(s) => s.name === field.type.name && !s.is_simple_type && !s.is_generic,
			);
			if (field_struct && !field_struct.is_class && struct_needs_destroy(field_struct, status)) {
				// Nested owning value struct: destroy the shallow-copied
				// sub-struct's fields, then deep-copy from source.
				status.code += `${field_struct.name}_destroy(&${dst}.${field.name});\n`;
				emit_deep_copy_fields(
					field_struct,
					`${dst}.${field.name}`,
					`${src}${arrow(src)}${field.name}`,
					status,
				);
			}
		}
	}
}

/** A struct value uses `.`; a struct pointer uses `->`. `val` is a pointer. */
function arrow(src: string): string {
	return src === "val" ? "->" : ".";
}
