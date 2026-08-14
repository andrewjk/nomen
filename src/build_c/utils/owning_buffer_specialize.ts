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
 *
 *
 * `string` elements use a parallel path: `string` is a primitive (not a value
 * struct), so the value-struct specialization above does not apply, but a
 * `Buffer<string>` slot holds a shallow-copied `char*` that may point into
 * rodata (a literal) or the heap (a concatenation). To be sound, the slot must
 * OWN an independent heap copy: `store_T` strdup's the incoming pointer,
 * `replace_T` frees the old slot then strdup's, and `#destroy` frees each slot
 * then the slab. `move_T`/`pop` then return an already-heap pointer directly
 * (no return-site strdup). The caller retains ownership of the ORIGINAL string
 * it pushed (string mov args are not spliced — see check_function_call), so
 * there is a single owner on each side: the buffer owns its strdup'd copies,
 * the caller owns the original. See ROADBLOCKS "List<string> owning
 * extraction".
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
	// `struct_needs_destroy` deliberately ignores `string` fields for struct
	// LOCAL scope-exit (a string-only local's strings are borrowed, not owned).
	// A Buffer element is different: the slot OWNS strdup'd strings (deep-copy
	// store_T), so a string-only struct (e.g. JsonNode with its `text` field)
	// must be recognized as owning too — mirroring the aarch64 backend's
	// `has_string_fields`. Without this the two backends diverge (aarch64
	// deep-copies, C stays shallow → `free` of a literal crashes).
	if (struct_needs_destroy(node, status)) return true;
	return has_string_fields(node, status);
}

/** Any string field (or a nested owning struct's string field)? */
function has_string_fields(node: StructNode, status: BuildStatus): boolean {
	for (const field of node.fields) {
		if (field.type.is_ref) continue;
		if (field.type.name === "string" && !field.type.is_array) return true;
		const field_struct = status.structs.find(
			(s) => s.name === field.type.name && !s.is_simple_type && !s.is_generic,
		);
		if (field_struct && !field_struct.is_class && has_string_fields(field_struct, status))
			return true;
	}
	return false;
}

/**
 * The names of Buffer methods that get specialized for owning value structs.
 * load_T and move_T are NOT specialized: load_T returns a shallow copy (a
 * borrow — the caller's struct local is not destroyed, so no double-free);
 * move_T transfers ownership (the slot is zeroed, the caller takes the
 * pointers).
 */
export const OWNING_BUFFER_METHODS = new Set(["store_T", "replace_T", "destroy", "#destroy"]);

/**
 * A `Buffer<string>` owns an independent heap copy of each slot (strdup on
 * store_T, free+strdup on replace_T, per-slot free on #destroy). The element
 * is a primitive, so this is a separate path from the value-struct
 * specialization above.
 */
export function owning_buffer_is_string_elem(node: StructNode): boolean {
	return node.name === "Buffer_string";
}

/**
 * Emit a specialized C body for a `Buffer<string>` method. Returns true if the
 * body was emitted. `self` is `struct Buffer_string*`, `i` is the index, and
 * `val` is the incoming `char*` (string is 8-byte, passed by value). The
 * signature + opening brace + _self deref have already been emitted by
 * build_struct_functions.
 */
export function emit_owning_buffer_string_body(func_name: string, status: BuildStatus): boolean {
	if (func_name === "#destroy") func_name = "destroy";
	if (!OWNING_BUFFER_METHODS.has(func_name)) return false;

	if (func_name === "store_T") {
		// store_T(self, i, val): strdup the incoming char* into the slot so the
		// slot owns an independent heap copy. The round-trip guard (val == old
		// slot) keeps the existing copy instead of orphaning it — a
		// load-modify-store round-trip must not strdup over its own alias.
		status.code += `char** _slots = (char**)self->data;\n`;
		status.code += `char* _old = _slots[i];\n`;
		status.code += `_slots[i] = (val && val != _old) ? strdup(val) : val;\n`;
		return true;
	}

	if (func_name === "replace_T") {
		// replace_T(self, i, val): free the old slot's heap copy, then strdup
		// the new value. When val aliases the old slot (round-trip), keep it.
		status.code += `char** _slots = (char**)self->data;\n`;
		status.code += `char* _old = _slots[i];\n`;
		status.code += `if (val != _old) { free(_old); _slots[i] = val ? strdup(val) : 0; }\n`;
		return true;
	}

	if (func_name === "destroy") {
		// #destroy(self): free each slot's heap copy, then free the slab.
		// Unused/moved slots are NULL (calloc-zeroed or zeroed by move_T), and
		// free(NULL) is a no-op, so iterating cap is safe.
		status.code += `if (self->data) {\n`;
		status.code += `char** _slots = (char**)self->data;\n`;
		status.code += `for (int _i = 0; _i < self->cap; _i++) { free(_slots[_i]); }\n`;
		status.code += `free(_slots);\n`;
		status.code += `}\n`;
		status.code += `self->data = 0;\n`;
		status.code += `self->cap = 0;\n`;
		return true;
	}

	return false;
}

/**
 * Emit a specialized C body for a Buffer method whose element type owns heap
 * data. Returns true if the body was emitted (the caller should skip the raw
 * block); false if the raw block should be used as-is.
 *
 * The signature + opening brace + _self deref have already been emitted by
 * build_struct_functions; this function only emits the body statements.
 */
export function emit_owning_buffer_body(
	func_name: string,
	elem: StructNode,
	status: BuildStatus,
): boolean {
	if (func_name === "#destroy") func_name = "destroy";
	if (!OWNING_BUFFER_METHODS.has(func_name)) return false;

	const Tptr = `struct ${elem.name} *`;
	const Tcast = `(struct ${elem.name} *)`;

	if (func_name === "store_T") {
		// store_T(self, i, val): shallow-copy the struct into the slot, then
		// strdup each string field so the slot owns an independent copy.
		// `emit_deep_copy_fields`'s round-trip guard (the captured `_old`
		// value) skips the strdup when the slot already owns the exact copy —
		// a load-modify-store round-trip re-store must not orphan its string.
		status.code += `${Tptr}_slots = ${Tcast}(unsigned long long)self->data;\n`;
		status.code += `struct ${elem.name} _old = _slots[i];\n`;
		status.code += `_slots[i] = (*val);\n`;
		emit_deep_copy_fields(elem, "_slots[i]", "val", status, "_old");
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
 *
 * `old_expr` (optional) is the slot's PRE-copy value expression. When the
 * source field pointer equals the old slot field pointer, the slot already
 * owns that exact copy — a load-modify-store round-trip (`var n =
 * load_T(i); n.f = x; store_T(i, n)`, where `n` aliases the slot's string) —
 * so the strdup is skipped and the slot keeps its existing copy instead of
 * orphaning it. A NULL source field stays NULL (JsonTree's "no text"
 * sentinel) — strdup(NULL) would crash.
 */
function emit_deep_copy_fields(
	elem: StructNode,
	dst: string,
	src: string,
	status: BuildStatus,
	old_expr?: string,
): void {
	for (const field of elem.fields) {
		if (field.type.is_ref) continue;
		if (field.type.name === "string" && !field.type.is_array) {
			const src_field = `${src}${arrow(src)}${field.name}`;
			if (old_expr) {
				status.code += `${dst}.${field.name} = (${src_field} && ${src_field} != ${old_expr}.${field.name}) ? strdup(${src_field}) : ${src_field};\n`;
			} else {
				status.code += `${dst}.${field.name} = ${src_field} ? strdup(${src_field}) : 0;\n`;
			}
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
