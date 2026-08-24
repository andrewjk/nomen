import type BuildStatus from "../../build_c/BuildStatus.ts";
import type_from_value_node from "../../build_c/utils/type_from_value_node.ts";
import {
	has_destroy,
	struct_needs_auto_destroy,
	struct_needs_destroy,
} from "../../build_common/destroy_analysis.ts";
import { mono_type_name } from "../../build_common/mono_name.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import aarch64_size from "./aarch64_size.ts";
import { emit_free } from "./audit.ts";
import { allocate_stack_space } from "./stack_var.ts";
import { emit_var_address, emit_var_load } from "./stack_var.ts";
import {
	get_field_offset,
	get_field_offset_of_fields,
	get_struct_size,
	get_type_size,
} from "./struct_layout.ts";

/**
 * Whether a declaration's initializer is a non-`mov` FIELD ACCESS — a shallow
 * struct borrow (`diff.changes`, the checker-hoisted `_param_N` temp for a
 * struct call arg). The struct bytes are copied but any embedded buffer data
 * belongs to the owner, so the declaration must NOT be destroyed at scope
 * exit / return (mirrors the C backend's is_destructured_field_access).
 */
export function is_field_struct_borrow(decl: { value?: unknown }): boolean {
	if (!decl.value || typeof decl.value !== "object") return false;
	const value = decl.value as AccessNode & { is_moved?: boolean };
	return (
		value.node_type === "access" && value.access.node_type === "access_field" && !value.is_moved
	);
}

/**
 * Record that a VALUE-struct local's `string` field now holds a heap-owned
 * value ("var.field"). See BuildStatus.heap_string_fields.
 */
export function record_heap_string_field(status: BuildStatus, var_name: string, field: string) {
	if (!status.heap_string_fields) status.heap_string_fields = new Set<string>();
	status.heap_string_fields.add(`${var_name}.${field}`);
}

/**
 * Drop a local's heap-string-field records — used when the struct's bytes
 * (and thus its string pointers) transfer to the caller, e.g. `return u`.
 */
export function clear_heap_string_fields(status: BuildStatus, var_name: string) {
	if (!status.heap_string_fields) return;
	const prefix = `${var_name}.`;
	for (const key of Array.from(status.heap_string_fields)) {
		if (key.startsWith(prefix)) status.heap_string_fields.delete(key);
	}
}

/**
 * Free every heap-owned string field recorded for `decl_name` (a VALUE-struct
 * local) and drop the records. Class locals are never recorded — their string
 * fields are unconditionally heap and freed by the destroy path. Called from
 * emit_destroy_for_decl and directly from cleanup loops that skip moved
 * declarations before reaching it.
 */
export function release_heap_string_fields(
	status: BuildStatus,
	decl_name: string,
	decl_type_name: string,
) {
	if (!status.heap_string_fields?.size) return;
	const prefix = `${decl_name}.`;
	const fields = Array.from(status.heap_string_fields)
		.filter((k) => k.startsWith(prefix))
		.map((k) => k.slice(prefix.length));
	if (!fields.length) return;
	for (const field of fields) {
		const offset = get_field_offset(decl_type_name, field, status);
		emit_var_address(status, "x0", decl_name);
		status.code += `ldr x0, [x0, #${offset}]\n`;
		emit_free(status);
		status.heap_string_fields.delete(`${decl_name}.${field}`);
	}
}

/**
 * Swap in a fresh scoped_declarations frame for a nested scope (if/while/
 * for/switch/match body), pushing the enclosing array onto
 * outer_scope_declarations so return-path cleanup can still reach it.
 * Pair with exit_scope_frame.
 */
export function enter_scope_frame(status: BuildStatus): DeclarationNode[] {
	const old = status.scoped_declarations ?? [];
	if (!status.outer_scope_declarations) status.outer_scope_declarations = [];
	status.outer_scope_declarations.push(old);
	status.scoped_declarations = [];
	return old;
}

/** Restore the enclosing scoped_declarations frame (enter_scope_frame's pair). */
export function exit_scope_frame(status: BuildStatus, old: DeclarationNode[]) {
	status.outer_scope_declarations?.pop();
	status.scoped_declarations = old;
}

/** Every declaration frame a `return` must clean: enclosing scopes first,
 *  the current (innermost) frame last — matching fall-through cleanup order. */
export function all_scope_frames(status: BuildStatus): DeclarationNode[][] {
	return [...(status.outer_scope_declarations ?? []), status.scoped_declarations ?? []];
}

export function mark_heap_string(status: BuildStatus, name: string) {
	if (!status.heap_strings) status.heap_strings = new Set<string>();
	status.heap_strings.add(name);
	if (status.heap_cleanup_stack?.length) {
		status.heap_cleanup_stack[status.heap_cleanup_stack.length - 1].heap_strings.add(name);
	}
}

export function anchor_heap_pointer(
	status: BuildStatus,
	var_name?: string,
	frame_index?: number,
	is_nullable?: boolean,
): number {
	const offset = allocate_stack_space(status, 8, 8);
	status.code += `str x0, [x29, #${offset}]\n`;
	if (status.heap_cleanup_stack?.length) {
		// By default a fresh anchor belongs to the current scope. But when
		// reassigning a variable declared in an outer scope (e.g. inside a loop
		// body), the new instance must live as long as the variable — so anchor
		// it in the variable's declaration frame, not the loop-body frame, or it
		// would be freed each iteration and leave the variable dangling.
		const frame =
			frame_index !== undefined && frame_index < status.heap_cleanup_stack.length
				? status.heap_cleanup_stack[frame_index]
				: status.heap_cleanup_stack[status.heap_cleanup_stack.length - 1];
		frame.heap_slots.push({ offset, var_name, is_nullable });
	}
	return offset;
}

export function emit_heap_slots_cleanup_for_return(status: BuildStatus) {
	const moved = status.moved ?? new Set<string>();
	for (const scope of status.heap_cleanup_stack ?? []) {
		for (const slot of scope.heap_slots) {
			if (slot.var_name && moved.has(slot.var_name)) continue;
			free_anchor_slot(status, slot);
		}
	}
}

export function find_anchor_slot(status: BuildStatus, var_name: string) {
	for (const scope of status.heap_cleanup_stack ?? []) {
		for (const slot of scope.heap_slots) {
			if (slot.var_name === var_name) return slot.offset;
		}
	}
	return undefined;
}

/**
 * Defer reclamation of a class instance being replaced by reassignment. The
 * instance's anchor slot is disowned (so the variable now resolves to the new
 * instance) and tagged with its type, so that at scope/return/break exit the
 * type's `#destroy` and field destroys run before the instance is freed. This
 * keeps borrows of the old instance's fields valid until the scope ends.
 *
 * Returns the index (in heap_cleanup_stack) of the frame the old slot lived
 * in — i.e. the variable's declaration frame — so the caller can anchor the
 * replacement there. Returns undefined if the old value wasn't anchored (caller
 * should fall back to eager cleanup).
 */
export function defer_anchor_destroy(
	status: BuildStatus,
	var_name: string,
	type_name: string,
	type_args?: Type[],
): number | undefined {
	for (let f = 0; f < (status.heap_cleanup_stack?.length ?? 0); f++) {
		const scope = status.heap_cleanup_stack![f];
		for (let i = scope.heap_slots.length - 1; i >= 0; i--) {
			const slot = scope.heap_slots[i];
			if (slot.var_name === var_name) {
				slot.var_name = undefined;
				slot.destroy_type = type_name;
				slot.destroy_type_args = type_args;
				return f;
			}
		}
	}
	return undefined;
}

/**
 * Find the anchor slot currently owned by `var_name`, remove it from the
 * cleanup stack (so it is NOT freed at scope exit), and return its stack
 * offset. Used for eager reclamation: the caller emits runtime code to
 * destroy+free the instance now (via the variable), so the slot must not be
 * freed again at exit. Returns undefined if the variable has no anchor.
 */
export function consume_anchor_slot(status: BuildStatus, var_name: string): number | undefined {
	for (let f = 0; f < (status.heap_cleanup_stack?.length ?? 0); f++) {
		const scope = status.heap_cleanup_stack![f];
		for (let i = scope.heap_slots.length - 1; i >= 0; i--) {
			if (scope.heap_slots[i].var_name === var_name) {
				const offset = scope.heap_slots[i].offset;
				scope.heap_slots.splice(i, 1);
				return offset;
			}
		}
	}
	return undefined;
}

/**
 * Flag the anchor slot currently owned by `var_name` to run the type's
 * `#destroy` (and field destroys) when the slot is freed at scope exit. Used
 * when an object-level alias — which is NOT tracked via scoped_declarations —
 * is reassigned to a fresh instance it now owns: without this, the anchored
 * instance would be freed at exit without its destructor running. (For regular
 * owners this is unnecessary: their #destroy runs via scoped_declarations, so
 * their live anchor slot carries no destroy_type.)
 */
export function mark_anchor_destroy(
	status: BuildStatus,
	var_name: string,
	type_name: string,
	type_args?: Type[],
) {
	for (let f = (status.heap_cleanup_stack?.length ?? 0) - 1; f >= 0; f--) {
		const scope = status.heap_cleanup_stack![f];
		for (let i = scope.heap_slots.length - 1; i >= 0; i--) {
			if (scope.heap_slots[i].var_name === var_name) {
				scope.heap_slots[i].destroy_type = type_name;
				scope.heap_slots[i].destroy_type_args = type_args;
				return;
			}
		}
	}
}

/**
 * Emit `#destroy` + field destroys for a class/struct instance whose pointer
 * lives in an anchor slot (offset from x29), reading the base pointer from the
 * slot rather than a named variable. Does NOT free the instance itself — the
 * caller frees the slot. Mirrors the field-destroy logic in emit_field_destroys
 * but for anonymous (disowned) anchor slots.
 */
export function emit_destroy_for_anchor_slot(
	status: BuildStatus,
	offset: number,
	type_name: string,
	type_args?: Type[],
	is_nullable?: boolean,
) {
	const resolved_name = resolve_struct_name(type_name, type_args, status);
	const struct_type = is_struct_type(resolved_name, status) || is_struct_type(type_name, status);
	// A trait-typed anchor (a trait-typed class local): dispatch destroy
	// through the trait's `<Trait>_destroy` shim, which reads the destroy slot
	// from the instance's vtable. The concrete type at runtime may differ from
	// the initializer's (after a reassignment), so destroy must dispatch
	// polymorphically rather than call a fixed concrete fn. The shim
	// dereferences obj, so guard a nullable slot. Does NOT free — the caller
	// frees the slot (mirroring the struct path below).
	if (!struct_type && status.traits.find((t) => t.name === type_name)) {
		let skip_label: string | undefined;
		if (is_nullable) {
			status.code += `ldr x0, [x29, #${offset}]\n`;
			skip_label = `.Lskip_na_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
			status.code += `cbz x0, ${skip_label}\n`;
		}
		status.code += `ldr x0, [x29, #${offset}]\n`;
		status.code += `bl ${type_name}_destroy\n`;
		if (skip_label) {
			status.code += `${skip_label}:\n`;
		}
		return;
	}
	if (!struct_type) return;
	// Guard the destroy + field-destroy sequence for nullable instances — the
	// slot may hold 0 (null), which owns nothing and must not be dereferenced.
	let skip_label: string | undefined;
	if (is_nullable && struct_type.is_class) {
		status.code += `ldr x0, [x29, #${offset}]\n`;
		skip_label = `.Lskip_na_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
		status.code += `cbz x0, ${skip_label}\n`;
	}
	if (has_destroy(struct_type)) {
		status.code += `ldr x0, [x29, #${offset}]\n`;
		status.code += `bl ${resolved_name}_destroy\n`;
	}
	emit_field_destroys_from_slot(status, struct_type, offset);
	if (skip_label) {
		status.code += `${skip_label}:\n`;
	}
}

function emit_field_destroys_from_slot(
	status: BuildStatus,
	struct_type: StructNode,
	base_offset: number,
) {
	for (const field of struct_type.fields) {
		const offset = get_field_offset_of_fields(struct_type.fields, field.name, status);
		const field_struct =
			is_struct_type(resolve_struct_name(field.type.name, field.type.type_args, status), status) ||
			is_struct_type(field.type.name, status);
		if (field_struct) {
			if (field_struct.is_class && !field.type.is_ref) {
				status.code += `ldr x0, [x29, #${base_offset}]\n`;
				status.code += `ldr x0, [x0, #${offset}]\n`;
				status.code += `str x0, [sp, #-16]!\n`;
				const label_id = (status.label_counter = (status.label_counter ?? 0) + 1);
				const skip_label = `.Lskip_defer_${label_id}`;
				status.code += `cbz x0, ${skip_label}\n`;
				status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
				status.code += `${skip_label}:\n`;
				status.code += `ldr x0, [sp], #16\n`;
				emit_free(status);
			} else if (has_destroy(field_struct)) {
				status.code += `ldr x0, [x29, #${base_offset}]\n`;
				status.code += `add x0, x0, #${offset}\n`;
				status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
			}
			emit_nested_field_destroys_from_slot(status, field_struct, base_offset + offset);
		} else if (field.type.name === "string" && !field.type.is_array && !field.type.is_ref) {
			// A `string` field: free the pointer. Value-struct anchor slots hold
			// strdup'd strings (the Buffer store copied them); class anchor slots
			// hold always-heap fields (`_init` strdup's defaults, assignments
			// strdup non-heap RHS) — either way the slot owns the string.
			status.code += `ldr x0, [x29, #${base_offset}]\n`;
			status.code += `ldr x0, [x0, #${offset}]\n`;
			emit_free(status);
		}
	}
}

function emit_nested_field_destroys_from_slot(
	status: BuildStatus,
	struct_type: StructNode,
	base_offset: number,
) {
	for (const field of struct_type.fields) {
		const offset = get_field_offset_of_fields(struct_type.fields, field.name, status);
		const field_struct =
			is_struct_type(resolve_struct_name(field.type.name, field.type.type_args, status), status) ||
			is_struct_type(field.type.name, status);
		if (field_struct) {
			if (has_destroy(field_struct)) {
				status.code += `ldr x0, [x29, #${base_offset}]\n`;
				status.code += `add x0, x0, #${offset}\n`;
				status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
			}
			emit_nested_field_destroys_from_slot(status, field_struct, base_offset + offset);
		}
	}
}

/**
 * Free an anchor slot, running its deferred destroy (if any) first.
 */
function free_anchor_slot(
	status: BuildStatus,
	slot: {
		offset: number;
		destroy_type?: string;
		destroy_type_args?: Type[];
		is_nullable?: boolean;
	},
) {
	if (slot.destroy_type) {
		emit_destroy_for_anchor_slot(
			status,
			slot.offset,
			slot.destroy_type,
			slot.destroy_type_args,
			slot.is_nullable,
		);
	}
	status.code += `ldr x0, [x29, #${slot.offset}]\n`;
	emit_free(status);
}

export function track_struct_decl(
	status: BuildStatus,
	name: string,
	type_name: string,
	type_args?: Type[],
	is_nullable?: boolean,
) {
	if (status.heap_cleanup_stack?.length) {
		status.heap_cleanup_stack[status.heap_cleanup_stack.length - 1].struct_decls.push({
			name,
			type_name,
			type_args,
			is_nullable,
		});
	}
}

export function resolve_struct_name(
	type_name: string,
	type_args?: Type[],
	status?: BuildStatus,
): string {
	if (type_args?.length) {
		const mono_name = mono_type_name(type_name, type_args);
		if (status?.structs.find((s) => s.name === mono_name)) return mono_name;
	}
	return type_name;
}

export function is_struct_type(type_name: string, status: BuildStatus): StructNode | undefined {
	return status.structs.find((s) => s.name === type_name && !s.is_simple_type);
}

export function emit_destroy_for_decl(
	status: BuildStatus,
	decl_name: string,
	decl_type_name: string,
	addr_offset?: number,
	type_args?: Type[],
	is_nullable?: boolean,
) {
	const moved = status.moved ?? new Set<string>();
	// A value struct's heap string fields are released even when the struct
	// itself was moved out: a container's store_T deep-copies (strdups) the
	// strings, so the source's own heap copies would otherwise be abandoned.
	// (A RETURN clears the records instead — the sret byte-copy transfers the
	// string pointers to the caller.)
	release_heap_string_fields(status, decl_name, decl_type_name);
	if (moved.has(decl_name)) return;

	if (status.heap_strings?.has(decl_name)) {
		if (addr_offset !== undefined) {
			status.code += `add x0, x0, #${addr_offset}\n`;
		} else {
			emit_var_load(status, "x0", decl_name, 8);
		}
		emit_free(status);
		return;
	}

	const resolved_name = resolve_struct_name(decl_type_name, type_args, status);
	const struct_type =
		is_struct_type(resolved_name, status) || is_struct_type(decl_type_name, status);
	if (!struct_type) return;

	// A nullable class instance is represented at runtime as a pointer that
	// may be 0 (null). Guard the whole destroy + field-destroy sequence with
	// a `cbz` so a null instance owns nothing and is never dereferenced.
	// (addr_offset is for nested fields, which are always non-null here since
	// the caller already loaded a live base pointer.)
	const guard_null = !!is_nullable && struct_type.is_class && addr_offset === undefined;
	let skip_label: string | undefined;
	if (guard_null) {
		emit_var_load(status, "x0", decl_name, 8);
		skip_label = `.Lskip_nd_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
		status.code += `cbz x0, ${skip_label}\n`;
	}

	// Every class HAS a `<Class>_destroy` function — a user `#destroy` or the
	// auto-generated one (build_struct_node) — and it reclaims ALL owning
	// fields (nested class instances, owning structs, always-heap string
	// fields). Call it for every class; the field-destroy recursion below is
	// only for value structs (repeating it after a class destroy would
	// double-free the fields).
	if (has_destroy(struct_type) || struct_type.is_class) {
		if (struct_type.is_class) {
			if (addr_offset !== undefined) {
				status.code += `ldr x0, [x0, #${addr_offset}]\n`;
			} else {
				emit_var_load(status, "x0", decl_name, 8);
			}
		} else {
			if (addr_offset !== undefined) {
				status.code += `add x0, x0, #${addr_offset}\n`;
			} else {
				emit_var_address(status, "x0", decl_name);
			}
		}
		status.code += `bl ${resolved_name}_destroy\n`;
	}

	if (struct_type.is_class) {
		if (status.heap_strings?.has(decl_name)) {
			if (addr_offset !== undefined) {
				status.code += `add x0, x0, #${addr_offset}\n`;
			} else {
				emit_var_load(status, "x0", decl_name, 8);
			}
			emit_free(status);
		}
		// No emit_field_destroys here — `<Class>_destroy` above already
		// reclaimed every owning field (strings included); repeating the
		// recursion would double-free them.
	} else if (struct_needs_destroy(struct_type, status)) {
		// Only emit field destroys for value structs that have a user #destroy
		// or class/nested-owning-struct fields. A struct whose only owning
		// fields are strings is NOT destroyed here — its strings may be raw
		// args (static literals), not heap. The Buffer per-element destroy
		// path calls <Struct>_destroy directly (which handles strings).
		// `free_strings=false`: this is struct LOCAL scope exit, where string
		// fields may be rodata literals (aarch64 constructors don't strdup);
		// the auto-generated <Struct>_destroy (Buffer path) is the one that
		// frees them.
		emit_field_destroys(status, struct_type, decl_name, addr_offset, undefined, false);
	}

	if (skip_label) {
		status.code += `${skip_label}:\n`;
	}
}

function emit_base_ptr(status: BuildStatus, decl_name: string, is_class_parent?: boolean) {
	if (is_class_parent) {
		emit_var_load(status, "x0", decl_name, 8);
	} else {
		emit_var_address(status, "x0", decl_name);
	}
}

export function emit_field_destroys(
	status: BuildStatus,
	struct_type: StructNode,
	decl_name: string,
	base_offset?: number,
	is_class_parent?: boolean,
	free_strings = true,
) {
	for (const field of struct_type.fields) {
		const offset = get_field_offset_of_fields(struct_type.fields, field.name, status);
		const resolved = resolve_struct_name(field.type.name, field.type.type_args, status);
		const field_struct =
			is_struct_type(resolved, status) || is_struct_type(field.type.name, status);
		if (field_struct) {
			if (field_struct.is_class && !field.type.is_ref) {
				if (decl_name) {
					emit_base_ptr(status, decl_name, is_class_parent);
				}
				const actual_offset = base_offset !== undefined ? base_offset + offset : offset;
				status.code += `ldr x0, [x0, #${actual_offset}]\n`;
				// Save child pointer, recursively destroy its fields, then free it
				status.code += `str x0, [sp, #-16]!\n`;
				const label_id = (status.label_counter = (status.label_counter ?? 0) + 1);
				const skip_label = `.Lskip_destroy_${label_id}`;
				status.code += `cbz x0, ${skip_label}\n`;
				status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
				status.code += `${skip_label}:\n`;
				status.code += `ldr x0, [sp], #16\n`;
				emit_free(status);
			} else {
				// Call the nested struct's OWN destroy if it has one (an explicit
				// `#destroy`) OR needs an auto-generated one (owning fields such as
				// a string field). Without this, a nested owning value struct (e.g.
				// `Outer { Inner inner }` where Inner has a string) leaks: the outer
				// auto-destroy never freed the inner struct's owned strings. The
				// auto-generated <Struct>_destroy already walks every owning
				// sub-field, so for the auto case we must NOT also recurse via
				// emit_nested_field_destroys (that would double-free them).
				const field_has_explicit_destroy = has_destroy(field_struct);
				const field_needs_destroy =
					field_has_explicit_destroy || struct_needs_auto_destroy(field_struct, status);
				if (field_needs_destroy) {
					const actual_offset = base_offset !== undefined ? base_offset + offset : offset;
					if (decl_name) {
						emit_base_ptr(status, decl_name, is_class_parent);
					}
					status.code += `add x0, x0, #${actual_offset}\n`;
					status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
				}
				if (field_has_explicit_destroy) {
					emit_nested_field_destroys(
						status,
						field_struct,
						decl_name,
						base_offset !== undefined ? base_offset + offset : offset,
						is_class_parent,
					);
				}
			}
		} else if (
			free_strings &&
			field.type.name === "string" &&
			!field.type.is_array &&
			!field.type.is_ref
		) {
			// A `string` field: free the pointer. For VALUE structs this fires
			// from the auto-generated <Struct>_destroy (Buffer per-element
			// destroy, where store_T strdup'd every string), NOT from struct
			// local scope exit — a local's string field may be a raw rodata
			// literal arg, so freeing it would `free` rodata (SIGABRT). For
			// CLASSES the field is always heap-owned (`_init` strdup's the
			// default, assignments strdup non-heap RHS), so it is freed here too.
			const actual_offset = base_offset !== undefined ? base_offset + offset : offset;
			if (decl_name) {
				emit_base_ptr(status, decl_name, is_class_parent);
			}
			status.code += `ldr x0, [x0, #${actual_offset}]\n`;
			emit_free(status);
		} else if (field.type.is_array) {
			const elem_struct = is_struct_type(field.type.name, status);
			if (elem_struct) {
				const elem_size = get_struct_size(field.type.name, status);
				const arr_len = field.type.length ? parseInt((field.type.length as any).value || "0") : 0;
				const actual_base = base_offset !== undefined ? base_offset + offset : offset;
				for (let i = 0; i < arr_len; i++) {
					emit_destroy_for_array_elem(
						status,
						elem_struct,
						decl_name,
						actual_base + i * elem_size,
						is_class_parent,
					);
				}
			}
		}
	}
}

function emit_nested_field_destroys(
	status: BuildStatus,
	struct_type: StructNode,
	decl_name: string,
	base_offset: number,
	is_class_parent?: boolean,
) {
	for (const field of struct_type.fields) {
		const offset = get_field_offset_of_fields(struct_type.fields, field.name, status);
		const field_struct =
			is_struct_type(resolve_struct_name(field.type.name, field.type.type_args, status), status) ||
			is_struct_type(field.type.name, status);
		if (field_struct) {
			if (has_destroy(field_struct)) {
				emit_base_ptr(status, decl_name, is_class_parent);
				status.code += `add x0, x0, #${base_offset + offset}\n`;
				status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
			}
			emit_nested_field_destroys(
				status,
				field_struct,
				decl_name,
				base_offset + offset,
				is_class_parent,
			);
		}
	}
}

function emit_destroy_for_array_elem(
	status: BuildStatus,
	struct_type: StructNode,
	decl_name: string,
	elem_offset: number,
	is_class_parent?: boolean,
) {
	if (has_destroy(struct_type)) {
		emit_base_ptr(status, decl_name, is_class_parent);
		status.code += `add x0, x0, #${elem_offset}\n`;
		status.code += `bl ${struct_type.name}_destroy\n`;
	}
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct =
			is_struct_type(resolve_struct_name(field.type.name, field.type.type_args, status), status) ||
			is_struct_type(field.type.name, status);
		if (field_struct) {
			const field_size = get_type_size(field.type, status);
			emit_nested_field_destroys(
				status,
				field_struct,
				decl_name,
				elem_offset + offset,
				is_class_parent,
			);
			offset += field_size;
		} else {
			offset += aarch64_size(field.type.name);
		}
	}
}

/**
 * Resolve the StructNode for a scoped declaration. For a normal struct/class
 * local this is just `decl.type.name`. For a trait-typed local (concrete
 * storage), the declared type is a trait and the actual storage is the
 * concrete struct from the initializer — recover it so destroy dispatches
 * correctly. Returns `{ struct_type, type_name, type_args }` or undefined.
 */
function resolve_decl_struct(
	decl: { type: { name: string; type_args?: Type[]; is_nullable?: boolean }; value?: any },
	status: BuildStatus,
): { struct_type: StructNode; type_name: string; type_args?: Type[] } | undefined {
	const resolved = resolve_struct_name(decl.type.name, decl.type.type_args, status);
	const direct = is_struct_type(resolved, status) || is_struct_type(decl.type.name, status);
	if (direct) {
		return { struct_type: direct, type_name: resolved, type_args: decl.type.type_args };
	}
	// Trait-typed local with concrete storage: recover the concrete struct
	// from the initializer's type.
	if (status.traits.find((t) => t.name === decl.type.name) && decl.value) {
		const val_type = type_from_value_node(decl.value);
		if (val_type?.name) {
			const concrete = is_struct_type(val_type.name, status);
			if (concrete) {
				return { struct_type: concrete, type_name: val_type.name, type_args: val_type.type_args };
			}
		}
	}
	return undefined;
}

export function emit_destroy_for_scope(status: BuildStatus, declarations_before: number) {
	const moved = status.moved ?? new Set();
	const current_scope = status.heap_cleanup_stack?.[status.heap_cleanup_stack.length - 1];
	if (current_scope?.heap_slots.length) {
		for (let i = declarations_before; i < status.scoped_declarations.length; i++) {
			const decl = status.scoped_declarations[i];
			// Recorded heap string fields are released for every decl before
			// the gates below: a string-only value struct is skipped by the
			// struct_needs_destroy gate, and a moved-out struct's records were
			// already dropped by the release (store_T deep-copied them).
			release_heap_string_fields(status, decl.name, decl.type.name);
			if (moved.has(decl.name)) {
				continue;
			}
			if (status.heap_string_arrays?.has(decl.name)) {
				const len = status.heap_string_arrays.get(decl.name)!;
				for (let j = 0; j < len; j++) {
					emit_var_address(status, "x0", decl.name);
					status.code += `ldr x0, [x0, #${j * 16}]\n`;
					emit_free(status);
				}
				continue;
			}
			if (status.heap_class_arrays?.has(decl.name)) {
				status.code += `str x19, [sp, #-16]!\n`;
				status.code += `str x20, [sp, #-16]!\n`;
				emit_var_load(status, "x0", decl.name, 8);
				status.code += `mov x19, x0\n`;
				status.code += `ldr x20, [x19]\n`;
				status.code += `cbz x20, .Lskip_cls_${decl.name}\n`;
				status.code += `add x19, x19, #8\n`;
				const label = `.Lcls_${decl.name}`;
				status.code += `${label}:\n`;
				status.code += `ldr x0, [x19]\n`;
				emit_free(status);
				status.code += `add x19, x19, #8\n`;
				status.code += `sub x20, x20, #1\n`;
				status.code += `cbnz x20, ${label}\n`;
				status.code += `.Lskip_cls_${decl.name}:\n`;
				// The elements are freed above; free the malloc'd buffer
				// itself too (x19 may have advanced past the data area, so
				// reload the pointer from the variable).
				emit_var_load(status, "x0", decl.name, 8);
				emit_free(status);
				status.code += `ldr x20, [sp], #16\n`;
				status.code += `ldr x19, [sp], #16\n`;
				continue;
			}
			if (status.heap_strings?.has(decl.name)) {
				emit_var_load(status, "x0", decl.name, 8);
				emit_free(status);
				continue;
			}
			// A shallow field-struct borrow (e.g. the hoisted `_param_N` copy
			// of `diff.changes`) is not destroyed — the owner frees it.
			if (is_field_struct_borrow(decl)) continue;
			const resolved_decl = resolve_decl_struct(decl, status);
			if (!resolved_decl) continue;
			const struct_type = resolved_decl.struct_type;
			if (!struct_needs_destroy(struct_type, status) && !struct_type.is_class) continue;
			emit_destroy_for_decl(
				status,
				decl.name,
				resolved_decl.type_name,
				undefined,
				resolved_decl.type_args,
				decl.type.is_nullable,
			);
		}
		for (const slot of current_scope.heap_slots) {
			if (slot.var_name && moved.has(slot.var_name)) continue;
			free_anchor_slot(status, slot);
		}
		return;
	}
	for (let i = declarations_before; i < status.scoped_declarations.length; i++) {
		const decl = status.scoped_declarations[i];
		// See the heap_slots branch above: recorded heap string fields are
		// released before the moved / struct_needs_destroy gates.
		release_heap_string_fields(status, decl.name, decl.type.name);
		if (moved.has(decl.name)) {
			continue;
		}
		if (status.heap_string_arrays?.has(decl.name)) {
			const len = status.heap_string_arrays.get(decl.name)!;
			for (let j = 0; j < len; j++) {
				emit_var_address(status, "x0", decl.name);
				status.code += `ldr x0, [x0, #${j * 16}]\n`;
				emit_free(status);
			}
			continue;
		}
		if (status.heap_class_arrays?.has(decl.name)) {
			status.code += `str x19, [sp, #-16]!\n`;
			status.code += `str x20, [sp, #-16]!\n`;
			emit_var_load(status, "x0", decl.name, 8);
			status.code += `mov x19, x0\n`;
			status.code += `ldr x20, [x19]\n`;
			status.code += `cbz x20, .Lskip_cls_${decl.name}\n`;
			status.code += `add x19, x19, #8\n`;
			const label = `.Lcls_${decl.name}`;
			status.code += `${label}:\n`;
			status.code += `ldr x0, [x19]\n`;
			emit_free(status);
			status.code += `add x19, x19, #8\n`;
			status.code += `sub x20, x20, #1\n`;
			status.code += `cbnz x20, ${label}\n`;
			status.code += `.Lskip_cls_${decl.name}:\n`;
			// Free the malloc'd buffer itself (see the heap_slots branch).
			emit_var_load(status, "x0", decl.name, 8);
			emit_free(status);
			status.code += `ldr x20, [sp], #16\n`;
			status.code += `ldr x19, [sp], #16\n`;
			continue;
		}
		// Heap-allocated arrays (e.g. from Array.with with a runtime count):
		// the variable holds a malloc'd buffer pointer ([ptr]=length, data
		// follows). Free the buffer. Class/string element arrays are handled
		// by heap_class_arrays/heap_string_arrays above (which `continue`).
		if (status.heap_array_vars?.has(decl.name)) {
			if (status.heap_owned_string_arrays?.has(decl.name)) {
				// Owned fat-string elements: free every slot's ptr half
				// (16-byte stride, data at buffer+8), then the buffer.
				status.code += `str x19, [sp, #-16]!\n`;
				status.code += `str x20, [sp, #-16]!\n`;
				emit_var_load(status, "x0", decl.name, 8);
				status.code += `mov x19, x0\n`;
				status.code += `ldr x20, [x19]\n`;
				status.code += `add x19, x19, #8\n`;
				const loop = `.Lhosa_${decl.name}`;
				status.code += `${loop}:\n`;
				status.code += `cbz x20, .Lhosa_done_${decl.name}\n`;
				status.code += `ldr x0, [x19]\n`;
				emit_free(status);
				status.code += `add x19, x19, #16\n`;
				status.code += `sub x20, x20, #1\n`;
				status.code += `b ${loop}\n`;
				status.code += `.Lhosa_done_${decl.name}:\n`;
				emit_var_load(status, "x0", decl.name, 8);
				emit_free(status);
				status.code += `ldr x20, [sp], #16\n`;
				status.code += `ldr x19, [sp], #16\n`;
				continue;
			}
			emit_var_load(status, "x0", decl.name, 8);
			emit_free(status);
			continue;
		}
		if (status.heap_strings?.has(decl.name)) {
			emit_var_load(status, "x0", decl.name, 8);
			emit_free(status);
			continue;
		}
		// A shallow field-struct borrow is not destroyed — see the
		// heap_slots branch above.
		if (is_field_struct_borrow(decl)) continue;
		const resolved_decl = resolve_decl_struct(decl, status);
		if (!resolved_decl) continue;
		const struct_type = resolved_decl.struct_type;
		if (!struct_needs_destroy(struct_type, status) && !struct_type.is_class) continue;
		emit_destroy_for_decl(
			status,
			decl.name,
			resolved_decl.type_name,
			undefined,
			resolved_decl.type_args,
			decl.type.is_nullable,
		);
	}
}

export function emit_cleanup_to_loop_depth(status: BuildStatus) {
	const loop = status.loop_labels?.[status.loop_labels.length - 1];
	if (!loop?.cleanup_depth || !status.heap_cleanup_stack) return;
	const depth = loop.cleanup_depth;
	for (let i = status.heap_cleanup_stack.length - 1; i >= depth; i--) {
		const scope = status.heap_cleanup_stack[i];
		if (scope.heap_slots.length) {
			for (const slot of scope.heap_slots) {
				free_anchor_slot(status, slot);
			}
			continue;
		}
		const moved = status.moved ?? new Set<string>();
		for (const entry of scope.struct_decls) {
			if (moved.has(entry.name)) continue;
			emit_destroy_for_decl(
				status,
				entry.name,
				entry.type_name,
				undefined,
				entry.type_args,
				entry.is_nullable,
			);
		}
		for (const name of scope.heap_strings) {
			if (moved.has(name)) continue;
			if (status.heap_string_arrays?.has(name)) {
				const len = status.heap_string_arrays.get(name)!;
				for (let j = 0; j < len; j++) {
					emit_var_address(status, "x0", name);
					status.code += `ldr x0, [x0, #${j * 8}]\n`;
					emit_free(status);
				}
				continue;
			}
			if (!status.heap_strings?.has(name)) continue;
			emit_var_load(status, "x0", name, 8);
			emit_free(status);
		}
	}
}

/**
 * When a heap-returning call's result is captured into an owned variable
 * (e.g. `var Box a = make(Box(5))`), the result is anchored as a fresh owner.
 * But if the call also received a same-type class temporary as a non-mov arg
 * (the hoisted `_param_N` for `Box(5)`), that temporary is anchored too — and
 * the function may return the very same instance (e.g. `return x ?? fallback`),
 * so both anchors point at one allocation and one gets double-freed. The
 * result variable supersedes the temporary, so release the temporary's anchor
 * (mark it moved) to consolidate to a single owner.
 */
export function consolidate_temp_anchors(
	status: BuildStatus,
	call_node: { node_type?: string; params?: any[]; mov_param_indices?: number[] } | undefined,
	result_type_name: string | undefined,
) {
	if (!call_node || call_node.node_type !== "func_call" || !call_node.params) return;
	if (!result_type_name) return;
	const is_class = !!status.structs.find((s) => s.name === result_type_name && s.is_class);
	if (!is_class) return;
	for (let i = 0; i < call_node.params.length; i++) {
		const p = call_node.params[i];
		if (p?.node_type !== "value") continue;
		if (call_node.mov_param_indices?.includes(i)) continue;
		const pname = p.value as string;
		// Only hoisted call temporaries (_param_N) — plain variables may still
		// be used after the call and must keep their own cleanup.
		if (!pname.startsWith("_param_")) continue;
		const ptype = p.type?.name;
		if (ptype !== result_type_name) continue;
		if (find_anchor_slot(status, pname) === undefined) continue;
		if (!status.moved) status.moved = new Set<string>();
		status.moved.add(pname);
	}
}

export function mark_moved_if_struct(
	value: any,
	status: BuildStatus,
	opts?: { for_return?: boolean },
) {
	if (value?.node_type !== "value") return;
	const var_name = value.value;
	let var_type = value.type;
	// A monomorphized method body is never re-checked, so a bare variable's
	// ValueNode.type can be unset (e.g. `return dst` inside List<T>.copy).
	// Resolve the type from the declaration so the moved-marking below still
	// fires — otherwise the return-path scope-exit cleanup destroys the
	// returned owning struct after its bytes were copied into the sret
	// buffer, leaving the caller with freed backing storage.
	if (!var_type?.name) {
		var_type = all_scope_frames(status)
			.flat()
			.find((d) => d.name === var_name)?.type;
	}
	if (!var_type) return;
	// Search every scope frame: a `mov`/`return` inside an if/loop body must
	// still recognize (and mark) locals declared in enclosing scopes.
	const is_local = all_scope_frames(status).some((frame) => frame.some((d) => d.name === var_name));
	const has_anchor = find_anchor_slot(status, var_name) !== undefined;
	const is_class_param =
		!!status.moved_class_params?.has(var_name) ||
		(!!status.function_param_regs?.has(var_name) && is_struct_type(var_type.name, status));
	if (!is_local && !has_anchor && !is_class_param) return;
	const is_struct = is_struct_type(var_type.name, status);
	if (is_struct) {
		if (!status.moved) status.moved = new Set<string>();
		status.moved.add(var_name);
	}
	// A RETURNED heap string transfers ownership to the caller (the return
	// cleanup must not free it) — but only in return context (for_return): a
	// plain `string` arg to a `mov T` param does NOT transfer ownership (an
	// owning `Buffer<string>` strdup's its own copy — the callee-copies
	// convention), so the caller retains and frees the original at scope
	// exit. (Mirrors the C backend's mov_param_indices string gate.) A string
	// field of a moved VALUE struct is likewise released at scope exit via
	// heap_string_fields — store_T deep-copied it.
	if (opts?.for_return && status.heap_strings?.has(var_name)) {
		if (!status.moved) status.moved = new Set<string>();
		status.moved.add(var_name);
	}
}
