import type BuildStatus from "../../build_c/BuildStatus.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import aarch64_size from "./aarch64_size.ts";
import { emit_free } from "./audit.ts";
import { allocate_stack_space } from "./stack_var.ts";
import { emit_var_address, emit_var_load } from "./stack_var.ts";
import { get_struct_size, get_type_size } from "./struct_layout.ts";

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
		frame.heap_slots.push({ offset, var_name });
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
 * Emit `#destroy` + field destroys for a class/struct instance whose pointer
 * lives in an anchor slot (offset from x29), reading the base pointer from the
 * slot rather than a named variable. Does NOT free the instance itself — the
 * caller frees the slot. Mirrors the field-destroy logic in emit_field_destroys
 * but for anonymous (disowned) anchor slots.
 */
function emit_destroy_for_anchor_slot(
	status: BuildStatus,
	offset: number,
	type_name: string,
	type_args?: Type[],
) {
	const resolved_name = resolve_struct_name(type_name, type_args, status);
	const struct_type = is_struct_type(resolved_name, status) || is_struct_type(type_name, status);
	if (!struct_type) return;
	if (has_destroy(struct_type)) {
		status.code += `ldr x0, [x29, #${offset}]\n`;
		status.code += `bl ${resolved_name}_destroy\n`;
	}
	emit_field_destroys_from_slot(status, struct_type, offset);
}

function emit_field_destroys_from_slot(
	status: BuildStatus,
	struct_type: StructNode,
	base_offset: number,
) {
	let offset = 8;
	for (const field of struct_type.fields) {
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
			const field_size = get_type_size(field.type, status);
			emit_nested_field_destroys_from_slot(status, field_struct, base_offset + offset);
			offset += field_size;
		} else {
			offset += aarch64_size(field.type.name);
		}
	}
}

function emit_nested_field_destroys_from_slot(
	status: BuildStatus,
	struct_type: StructNode,
	base_offset: number,
) {
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct =
			is_struct_type(resolve_struct_name(field.type.name, field.type.type_args, status), status) ||
			is_struct_type(field.type.name, status);
		if (field_struct) {
			if (has_destroy(field_struct)) {
				status.code += `ldr x0, [x29, #${base_offset}]\n`;
				status.code += `add x0, x0, #${offset}\n`;
				status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
			}
			const field_size = get_type_size(field.type, status);
			emit_nested_field_destroys_from_slot(status, field_struct, base_offset + offset);
			offset += field_size;
		} else {
			offset += aarch64_size(field.type.name);
		}
	}
}

/**
 * Free an anchor slot, running its deferred destroy (if any) first.
 */
function free_anchor_slot(
	status: BuildStatus,
	slot: { offset: number; destroy_type?: string; destroy_type_args?: Type[] },
) {
	if (slot.destroy_type) {
		emit_destroy_for_anchor_slot(status, slot.offset, slot.destroy_type, slot.destroy_type_args);
	}
	status.code += `ldr x0, [x29, #${slot.offset}]\n`;
	emit_free(status);
}

export function track_struct_decl(
	status: BuildStatus,
	name: string,
	type_name: string,
	type_args?: Type[],
) {
	if (status.heap_cleanup_stack?.length) {
		status.heap_cleanup_stack[status.heap_cleanup_stack.length - 1].struct_decls.push({
			name,
			type_name,
			type_args,
		});
	}
}

export function resolve_struct_name(
	type_name: string,
	type_args?: Type[],
	status?: BuildStatus,
): string {
	if (type_args?.length) {
		const mono_name = type_name + "_" + type_args.map((t) => t.name).join("_");
		if (status?.structs.find((s) => s.name === mono_name)) return mono_name;
	}
	return type_name;
}

export function is_struct_type(type_name: string, status: BuildStatus): StructNode | undefined {
	return status.structs.find((s) => s.name === type_name && !s.is_simple_type);
}

function has_destroy(struct_type: StructNode): boolean {
	return !!struct_type.functions.find((f) => f.name === "#destroy");
}

export function emit_destroy_for_decl(
	status: BuildStatus,
	decl_name: string,
	decl_type_name: string,
	addr_offset?: number,
	type_args?: Type[],
) {
	const moved = status.moved ?? new Set<string>();
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

	if (has_destroy(struct_type)) {
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
		emit_field_destroys(status, struct_type, decl_name, addr_offset, true);
	} else {
		emit_field_destroys(status, struct_type, decl_name, addr_offset);
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
) {
	let offset = 8;
	for (const field of struct_type.fields) {
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
				if (has_destroy(field_struct)) {
					const actual_offset = base_offset !== undefined ? base_offset + offset : offset;
					if (decl_name) {
						emit_base_ptr(status, decl_name, is_class_parent);
					}
					status.code += `add x0, x0, #${actual_offset}\n`;
					status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
				}
				emit_nested_field_destroys(
					status,
					field_struct,
					decl_name,
					base_offset !== undefined ? base_offset + offset : offset,
					is_class_parent,
				);
			}
			const field_size = get_type_size(field.type, status);
			offset += field_size;
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
			const elem_size = aarch64_size(field.type.name);
			const arr_len = field.type.length ? parseInt((field.type.length as any).value || "0") : 0;
			offset += elem_size * arr_len;
		} else {
			offset += aarch64_size(field.type.name);
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
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct =
			is_struct_type(resolve_struct_name(field.type.name, field.type.type_args, status), status) ||
			is_struct_type(field.type.name, status);
		if (field_struct) {
			if (has_destroy(field_struct)) {
				emit_base_ptr(status, decl_name, is_class_parent);
				status.code += `add x0, x0, #${base_offset + offset}\n`;
				status.code += `bl ${resolve_struct_name(field_struct.name, field.type.type_args, status)}_destroy\n`;
			}
			const field_size = get_type_size(field.type, status);
			emit_nested_field_destroys(
				status,
				field_struct,
				decl_name,
				base_offset + offset,
				is_class_parent,
			);
			offset += field_size;
		} else {
			offset += aarch64_size(field.type.name);
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

export function emit_destroy_for_scope(status: BuildStatus, declarations_before: number) {
	const moved = status.moved ?? new Set();
	const current_scope = status.heap_cleanup_stack?.[status.heap_cleanup_stack.length - 1];
	if (current_scope?.heap_slots.length) {
		for (let i = declarations_before; i < status.scoped_declarations.length; i++) {
			const decl = status.scoped_declarations[i];
			if (moved.has(decl.name)) continue;
			if (status.heap_string_arrays?.has(decl.name)) {
				const len = status.heap_string_arrays.get(decl.name)!;
				for (let j = 0; j < len; j++) {
					emit_var_address(status, "x0", decl.name);
					status.code += `ldr x0, [x0, #${j * 8}]\n`;
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
				status.code += `ldr x20, [sp], #16\n`;
				status.code += `ldr x19, [sp], #16\n`;
				continue;
			}
			if (status.heap_strings?.has(decl.name)) {
				emit_var_load(status, "x0", decl.name, 8);
				emit_free(status);
				continue;
			}
			const resolved = resolve_struct_name(decl.type.name, decl.type.type_args, status);
			const struct_type =
				is_struct_type(resolved, status) || is_struct_type(decl.type.name, status);
			if (!struct_type) continue;
			if (
				!has_destroy(struct_type) &&
				!has_struct_fields_with_destroy(struct_type, status) &&
				!struct_type.is_class
			)
				continue;
			emit_destroy_for_decl(status, decl.name, decl.type.name, undefined, decl.type.type_args);
		}
		for (const slot of current_scope.heap_slots) {
			if (slot.var_name && moved.has(slot.var_name)) continue;
			free_anchor_slot(status, slot);
		}
		return;
	}
	for (let i = declarations_before; i < status.scoped_declarations.length; i++) {
		const decl = status.scoped_declarations[i];
		if (moved.has(decl.name)) continue;
		if (status.heap_string_arrays?.has(decl.name)) {
			const len = status.heap_string_arrays.get(decl.name)!;
			for (let j = 0; j < len; j++) {
				emit_var_address(status, "x0", decl.name);
				status.code += `ldr x0, [x0, #${j * 8}]\n`;
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
			status.code += `ldr x20, [sp], #16\n`;
			status.code += `ldr x19, [sp], #16\n`;
			continue;
		}
		if (status.heap_strings?.has(decl.name)) {
			emit_var_load(status, "x0", decl.name, 8);
			emit_free(status);
			continue;
		}
		const struct_type = is_struct_type(decl.type.name, status);
		if (!struct_type) continue;
		if (
			!has_destroy(struct_type) &&
			!has_struct_fields_with_destroy(struct_type, status) &&
			!struct_type.is_class
		)
			continue;
		emit_destroy_for_decl(status, decl.name, decl.type.name, undefined, decl.type.type_args);
	}
}

export function has_struct_fields_with_destroy(
	struct_type: StructNode,
	status: BuildStatus,
): boolean {
	for (const field of struct_type.fields) {
		if (field.type.is_ref) continue;
		const field_struct =
			is_struct_type(resolve_struct_name(field.type.name, field.type.type_args, status), status) ||
			is_struct_type(field.type.name, status);
		if (field_struct) {
			if (field_struct.is_class) return true;
			if (has_destroy(field_struct)) return true;
			if (has_struct_fields_with_destroy(field_struct, status)) return true;
		}
	}
	return false;
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
			emit_destroy_for_decl(status, entry.name, entry.type_name, undefined, entry.type_args);
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

export function mark_moved_if_struct(value: any, status: BuildStatus) {
	if (value?.node_type !== "value") return;
	const var_name = value.value;
	const var_type = value.type;
	if (!var_type) return;
	const is_local = status.scoped_declarations.some((d) => d.name === var_name);
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
	if (status.heap_strings?.has(var_name)) {
		if (!status.moved) status.moved = new Set<string>();
		status.moved.add(var_name);
	}
}
