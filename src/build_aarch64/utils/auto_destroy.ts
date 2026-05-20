import type BuildStatus from "../../build/BuildStatus.ts";
import StructNode from "../../nodes/StructNode.ts";
import aarch64_size from "./aarch64_size.ts";
import { emit_free } from "./audit.ts";
import { emit_var_address, emit_var_load } from "./stack_var.ts";
import { get_struct_size } from "./struct_layout.ts";

export function mark_heap_string(status: BuildStatus, name: string) {
	if (!status.heap_strings) status.heap_strings = new Set<string>();
	status.heap_strings.add(name);
}

function is_struct_type(type_name: string, status: BuildStatus): StructNode | undefined {
	return status.structs.find((s) => s.name === type_name && !s.is_simple_type);
}

function has_destroy(struct_type: StructNode): boolean {
	return !!struct_type.destroy_body;
}

export function emit_destroy_for_decl(
	status: BuildStatus,
	decl_name: string,
	decl_type_name: string,
	addr_offset?: number,
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

	const struct_type = is_struct_type(decl_type_name, status);
	if (!struct_type) return;

	if (has_destroy(struct_type)) {
		if (addr_offset !== undefined) {
			status.code += `add x0, x0, #${addr_offset}\n`;
		} else {
			emit_var_address(status, "x0", decl_name);
		}
		status.code += `bl ${struct_type.name}_destroy\n`;
	}

	emit_field_destroys(status, struct_type, decl_name, addr_offset);
}

function emit_field_destroys(
	status: BuildStatus,
	struct_type: StructNode,
	decl_name: string,
	base_offset?: number,
) {
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct = is_struct_type(field.type.name, status);
		if (field_struct) {
			if (has_destroy(field_struct)) {
				const actual_offset = base_offset !== undefined ? base_offset + offset : offset;
				if (decl_name) {
					emit_var_address(status, "x0", decl_name);
				}
				status.code += `add x0, x0, #${actual_offset}\n`;
				status.code += `bl ${field_struct.name}_destroy\n`;
			}
			const field_size = get_struct_size(field.type.name, status);
			emit_nested_field_destroys(
				status,
				field_struct,
				decl_name,
				base_offset !== undefined ? base_offset + offset : offset,
			);
			offset += field_size;
		} else if (field.type.is_array) {
			const elem_struct = is_struct_type(field.type.name, status);
			if (elem_struct) {
				const elem_size = get_struct_size(field.type.name, status);
				const arr_len = field.type.length ? parseInt((field.type.length as any).value || "0") : 0;
				const actual_base = base_offset !== undefined ? base_offset + offset : offset;
				for (let i = 0; i < arr_len; i++) {
					emit_destroy_for_array_elem(status, elem_struct, decl_name, actual_base + i * elem_size);
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
) {
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct = is_struct_type(field.type.name, status);
		if (field_struct) {
			if (has_destroy(field_struct)) {
				emit_var_address(status, "x0", decl_name);
				status.code += `add x0, x0, #${base_offset + offset}\n`;
				status.code += `bl ${field_struct.name}_destroy\n`;
			}
			const field_size = get_struct_size(field.type.name, status);
			emit_nested_field_destroys(status, field_struct, decl_name, base_offset + offset);
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
) {
	if (has_destroy(struct_type)) {
		emit_var_address(status, "x0", decl_name);
		status.code += `add x0, x0, #${elem_offset}\n`;
		status.code += `bl ${struct_type.name}_destroy\n`;
	}
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct = is_struct_type(field.type.name, status);
		if (field_struct) {
			const field_size = get_struct_size(field.type.name, status);
			emit_nested_field_destroys(status, field_struct, decl_name, elem_offset + offset);
			offset += field_size;
		} else {
			offset += aarch64_size(field.type.name);
		}
	}
}

export function emit_destroy_for_scope(status: BuildStatus, declarations_before: number) {
	const moved = status.moved ?? new Set<string>();
	for (let i = declarations_before; i < status.scoped_declarations.length; i++) {
		const decl = status.scoped_declarations[i];
		if (moved.has(decl.name)) continue;
		if (status.heap_strings?.has(decl.name)) {
			emit_var_load(status, "x0", decl.name, 8);
			emit_free(status);
			continue;
		}
		const struct_type = is_struct_type(decl.type.name, status);
		if (!struct_type) continue;
		if (!has_destroy(struct_type) && !has_struct_fields_with_destroy(struct_type, status)) continue;
		emit_destroy_for_decl(status, decl.name, decl.type.name);
	}
}

function has_struct_fields_with_destroy(struct_type: StructNode, status: BuildStatus): boolean {
	for (const field of struct_type.fields) {
		const field_struct = is_struct_type(field.type.name, status);
		if (field_struct) {
			if (has_destroy(field_struct)) return true;
			if (has_struct_fields_with_destroy(field_struct, status)) return true;
		}
	}
	return false;
}

export function mark_moved_if_struct(value: any, status: BuildStatus) {
	if (value?.node_type !== "value") return;
	const var_name = value.value;
	const var_type = value.type;
	if (!var_type) return;
	const is_local = status.scoped_declarations.some((d) => d.name === var_name);
	if (!is_local) return;
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
