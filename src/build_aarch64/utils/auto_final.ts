import type BuildStatus from "../../build/BuildStatus.ts";
import StructNode from "../../nodes/StructNode.ts";
import aarch64_size from "./aarch64_size.ts";
import { emit_var_address } from "./stack_var.ts";
import { get_struct_size } from "./struct_layout.ts";

function is_struct_type(type_name: string, status: BuildStatus): StructNode | undefined {
	return status.structs.find((s) => s.name === type_name && !s.is_simple_type);
}

function has_final_func(struct_type: StructNode) {
	return struct_type.functions.find((f) => f.is_final);
}

export function emit_auto_final_for_decl(
	status: BuildStatus,
	decl_name: string,
	decl_type_name: string,
	addr_offset?: number,
) {
	const finalized = status.finalized ?? new Set<string>();
	if (finalized.has(decl_name)) return;

	const struct_type = is_struct_type(decl_type_name, status);
	if (!struct_type) return;

	const final_func = has_final_func(struct_type);
	if (final_func) {
		if (addr_offset !== undefined) {
			status.code += `add x0, x0, #${addr_offset}\n`;
		} else {
			emit_var_address(status, "x0", decl_name);
		}
		status.code += `bl ${struct_type.name}_${final_func.name}\n`;
	}

	emit_field_finals(status, struct_type, decl_name, addr_offset);
}

function emit_field_finals(
	status: BuildStatus,
	struct_type: StructNode,
	decl_name: string,
	base_offset?: number,
) {
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct = is_struct_type(field.type.name, status);
		if (field_struct) {
			const field_final = has_final_func(field_struct);
			if (field_final) {
				const actual_offset = base_offset !== undefined ? base_offset + offset : undefined;
				if (actual_offset !== undefined) {
					if (decl_name) {
						emit_var_address(status, "x0", decl_name);
					}
					status.code += `add x0, x0, #${actual_offset}\n`;
				} else {
					emit_var_address(status, "x0", decl_name);
					status.code += `add x0, x0, #${offset}\n`;
				}
				status.code += `bl ${field_struct.name}_${field_final.name}\n`;
			}
			const field_size = get_struct_size(field.type.name, status);
			emit_nested_field_finals(
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
					emit_final_for_array_elem(status, elem_struct, decl_name, actual_base + i * elem_size);
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

function emit_nested_field_finals(
	status: BuildStatus,
	struct_type: StructNode,
	decl_name: string,
	base_offset: number,
) {
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct = is_struct_type(field.type.name, status);
		if (field_struct) {
			const field_final = has_final_func(field_struct);
			if (field_final) {
				emit_var_address(status, "x0", decl_name);
				status.code += `add x0, x0, #${base_offset + offset}\n`;
				status.code += `bl ${field_struct.name}_${field_final.name}\n`;
			}
			const field_size = get_struct_size(field.type.name, status);
			emit_nested_field_finals(status, field_struct, decl_name, base_offset + offset);
			offset += field_size;
		} else {
			offset += aarch64_size(field.type.name);
		}
	}
}

function emit_final_for_array_elem(
	status: BuildStatus,
	struct_type: StructNode,
	decl_name: string,
	elem_offset: number,
) {
	const final_func = has_final_func(struct_type);
	if (final_func) {
		emit_var_address(status, "x0", decl_name);
		status.code += `add x0, x0, #${elem_offset}\n`;
		status.code += `bl ${struct_type.name}_${final_func.name}\n`;
	}
	let offset = 8;
	for (const field of struct_type.fields) {
		const field_struct = is_struct_type(field.type.name, status);
		if (field_struct) {
			const field_size = get_struct_size(field.type.name, status);
			emit_nested_field_finals(status, field_struct, decl_name, elem_offset + offset);
			offset += field_size;
		} else {
			offset += aarch64_size(field.type.name);
		}
	}
}

export function emit_auto_final_for_scope(status: BuildStatus, declarations_before: number) {
	const finalized = status.finalized ?? new Set<string>();
	for (let i = declarations_before; i < status.scoped_declarations.length; i++) {
		const decl = status.scoped_declarations[i];
		if (finalized.has(decl.name)) continue;
		const struct_type = is_struct_type(decl.type.name, status);
		if (!struct_type) continue;
		if (!has_final_func(struct_type) && !has_struct_fields(struct_type, status)) continue;
		emit_auto_final_for_decl(status, decl.name, decl.type.name);
	}
}

function has_struct_fields(struct_type: StructNode, status: BuildStatus): boolean {
	for (const field of struct_type.fields) {
		if (is_struct_type(field.type.name, status)) return true;
	}
	return false;
}

export function mark_moved_if_struct(value: any, status: BuildStatus) {
	if (value?.node_type !== "value") return;
	const var_name = value.value;
	const var_type = value.type;
	if (!var_type) return;
	const is_struct = is_struct_type(var_type.name, status);
	const is_local = status.scoped_declarations.some((d) => d.name === var_name);
	if (is_struct && is_local) {
		if (!status.finalized) status.finalized = new Set<string>();
		status.finalized.add(var_name);
	}
}
