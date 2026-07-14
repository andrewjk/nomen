import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { mangled_label } from "../check/utils/function_overload.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_inline_method from "./build_inline_method.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free, emit_malloc } from "./utils/audit.ts";
import { mark_moved_if_struct } from "./utils/auto_destroy.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	emit_var_load,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import { get_enum_size } from "./utils/struct_layout.ts";
import { get_field_offset, get_struct_size } from "./utils/struct_layout.ts";

export function emit_address_of(node: BaseNode, status: BuildStatus) {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x0", name);
		} else if (status.heap_array_vars?.has(name)) {
			emit_var_load(status, "x0", name, 8);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const access_field = access.access as AccessFieldNode;
			const target_type = type_from_value_node(access.target);
			const offset = get_field_offset(target_type.name, access_field.name, status);
			if (access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				const paramReg = get_param_reg(name, status);
				if (paramReg) {
					if (paramReg !== "x0") {
						status.code += `mov x0, ${paramReg}\n`;
					}
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
			} else {
				emit_address_of(access.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}
			if (offset) {
				status.code += `add x0, x0, #${offset}\n`;
			}
		} else {
			build_node(node, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}
	} else {
		build_node(node, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}
}

let access_temp_counter = 0;

function is_struct_type(type_name: string, status: BuildStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && !s.is_simple_type);
}

function resolve_field_type(
	access_field: AccessFieldNode,
	target_type_name: string | undefined,
	status: BuildStatus,
): Type | undefined {
	if (access_field.type?.name) return access_field.type;
	if (!target_type_name) return undefined;
	const target_struct = status.structs.find(
		(s) => s.name === target_type_name && !s.is_simple_type,
	);
	const field = target_struct?.fields.find((f) => f.name === access_field.name);
	return field?.type;
}

export function reset_access_temp_counter() {
	access_temp_counter = 0;
}

export default function build_access_node(node: AccessNode, status: BuildStatus) {
	switch (node.access.node_type) {
		case "access_field": {
			build_access_field(node, status);
			break;
		}
		case "access_func": {
			const access_func = node.access as AccessFunctionCallNode;
			build_access_method(node, access_func, status);
			break;
		}
	}
}

function compute_field_offset(node: AccessNode, status: BuildStatus): number {
	if (node.access.node_type === "access_field") {
		let target_type = type_from_value_node(node.target);
		if (!target_type?.name && node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			if (name === "self" && status.current_struct) {
				target_type = new Type(status.current_struct.name);
			} else if (status.variable_types?.has(name)) {
				target_type = status.variable_types.get(name)!;
			} else {
				// Local variables: look up the declaration's type so that
				// nested field access on locals resolves the correct offset.
				const decl = status.scoped_declarations.findLast((d) => d.name === name);
				if (decl?.type?.name) {
					target_type = decl.type;
				}
			}
		}
		// Resolve access targets whose type_from_value_node returned empty.
		// This happens for nested struct field access like `self.keys.cap`
		// where the access_field's .type wasn't populated during checking —
		// resolve_access_type walks the chain via status.structs instead.
		if (!target_type?.name && node.target.node_type === "access") {
			const resolved = resolve_access_type(node.target as AccessNode, status);
			if (resolved) target_type = resolved;
		}
		const field_name = (node.access as AccessFieldNode).name;
		let offset = get_field_offset(target_type?.name || "", field_name, status);

		if (node.target.node_type === "access") {
			const inner_access = node.target as AccessNode;
			offset += compute_field_offset(inner_access, status);
		}

		return offset;
	}

	return 0;
}

function get_base_target(node: AccessNode): ValueNode | AccessNode {
	if (node.target.node_type === "access") {
		return get_base_target(node.target as AccessNode);
	}
	return node.target as ValueNode;
}

function get_param_reg(name: string, status: BuildStatus): string | undefined {
	return status.function_param_regs?.get(name);
}

function build_access_field(node: AccessNode, status: BuildStatus) {
	let target_type = type_from_value_node(node.target);
	if (!target_type?.name && node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		if (name === "self" && status.current_struct) {
			target_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(name)) {
			target_type = status.variable_types.get(name)!;
		} else {
			// Local variables: look up the declaration's type.
			// Without this, nested field access on locals (e.g. `old_keys.cap`)
			// falls back to VT_SIZE for the offset, reading the wrong field.
			const decl = status.scoped_declarations.findLast((d) => d.name === name);
			if (decl?.type?.name) {
				target_type = decl.type;
			}
		}
	}
	const target_name =
		node.target.node_type === "value" ? (node.target as ValueNode).value : target_type?.name;
	const access_field = node.access as AccessFieldNode;

	if (access_field.type?.name === "func") {
		status.code += `adr x0, ${target_type.name}_${access_field.name}\n`;
		return;
	}

	const enum_node = status.enums.find((e) => e.name === (target_name || target_type?.name));
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === access_field.name);
		if (enum_case) {
			const case_index = enum_node.cases.indexOf(enum_case);
			if (enum_node.has_associated_data && enum_case.params.length === 0) {
				const enum_size = get_enum_size(target_name || target_type?.name || "", status);
				const temp_name = `_enum_${access_temp_counter++}`;
				const temp_offset = allocate_stack_space(status, enum_size);
				status.stack_offsets!.set(temp_name, temp_offset);
				status.code += `add x0, x29, #${temp_offset}\n`;
				status.code += `mov x1, #${case_index}\n`;
				status.code += `str x1, [x0]\n`;
				for (let off = 8; off < enum_size; off += 8) {
					status.code += `str xzr, [x0, #${off}]\n`;
				}
			} else {
				status.code += `mov x0, #${case_index}\n`;
			}
			return;
		}
	}

	// Check for enum payload field access (e.g., insect.count)
	const enum_with_data = status.enums.find(
		(e) => e.name === (target_name || target_type?.name) && e.has_associated_data,
	);
	if (enum_with_data) {
		for (const c of enum_with_data.cases) {
			const param = c.params.find((p) => p.name === access_field.name);
			if (param) {
				let payload_offset = 8;
				for (const p of c.params) {
					if (p.name === access_field.name) break;
					payload_offset += aarch64_size(p.type.name);
				}
				if (node.target.node_type === "value") {
					const name = (node.target as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						if (paramReg !== "x0") {
							status.code += `mov x0, ${paramReg}\n`;
						}
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x0", name);
					} else if (status.heap_array_vars?.has(name)) {
						emit_var_load(status, "x0", name, 8);
						status.code += `add x0, x0, #8\n`;
					} else {
						emit_var_address(status, "x0", name);
					}
				} else {
					build_node(node.target, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
				}
				const field_type = access_field.type?.name || "int";
				const field_size = aarch64_size(field_type);
				const signed =
					field_type.startsWith("int") ||
					field_type === "float" ||
					field_type === "float32" ||
					field_type === "float64";
				if (field_size === 1) {
					status.code += signed
						? `ldrsb x0, [x0, #${payload_offset}]\n`
						: `ldrb w0, [x0, #${payload_offset}]\n`;
				} else if (field_size === 4) {
					status.code += signed
						? `ldrsw x0, [x0, #${payload_offset}]\n`
						: `ldr w0, [x0, #${payload_offset}]\n`;
				} else {
					status.code += `ldr x0, [x0, #${payload_offset}]\n`;
				}
				return;
			}
		}
	}

	const bitset_node = status.bitsets.find((b) => b.name === target_type.name);
	if (bitset_node) {
		const case_index = bitset_node.cases.indexOf(access_field.name);
		if (case_index >= 0) {
			status.code += `mov x0, #(1 << ${case_index})\n`;
			return;
		}
	}

	if (target_type.is_array && access_field.name === "length") {
		// Variadic param .length → load from stack offset of hidden _name_len
		if (
			node.target.node_type === "value" &&
			status.function_variadic_params?.has((node.target as ValueNode).value)
		) {
			const name = (node.target as ValueNode).value;
			const offset = status.stack_offsets?.get(`_${name}_len`);
			if (offset !== undefined) {
				status.code += `ldr x0, [x29, #${offset}]\n`;
			} else {
				status.code += `mov x0, #0\n`;
			}
			return;
		}
		// For heap arrays: load pointer, then load length from [pointer]
		if (
			node.target.node_type === "value" &&
			status.heap_array_vars?.has((node.target as ValueNode).value)
		) {
			const name = (node.target as ValueNode).value;
			emit_var_load(status, "x0", name, 8);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `ldr x0, [x0]\n`;
			return;
		}
		// For stack arrays: load length from the 8-byte prefix at [base - 8]
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const offset = status.stack_offsets?.get(name);
			if (offset !== undefined) {
				// Array parameters store a pointer — dereference to get length from [ptr - 8]
				if (status.function_array_params?.has(name)) {
					status.code += `ldr x0, [x29, #${offset}]\n`;
					status.code += `ldr x0, [x0, #-8]\n`;
				} else {
					status.code += `ldr x0, [x29, #${offset - 8}]\n`;
				}
				return;
			}
			// Global array: length prefix is at label - 8
			status.code += `adr x0, ${name}\n`;
			status.code += `ldr x0, [x0, #-8]\n`;
			return;
		}
		status.code += `mov x0, #0\n`;
		return;
	}

	// String.length → strlen(self)
	if (target_type.name === "string" && access_field.name === "length") {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `bl _strlen\n`;
		return;
	}

	const offset = compute_field_offset(node, status);
	const base = get_base_target(node);

	const target_is_class_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_field" &&
		!!status.structs.find(
			(s) =>
				s.name === ((node.target as AccessNode).access as AccessFieldNode).type?.name && s.is_class,
		);

	// When target is a method call (e.g., points.at(0).x), build the method call
	// which leaves the result in x0, then apply the field offset from x0
	const target_is_method_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_func";

	if (target_is_method_access) {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const final_offset = offset;
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
		}
		return;
	}

	if (target_is_class_access) {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const final_offset = get_field_offset(target_type?.name || "", access_field.name, status);
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
		}
		return;
	}

	const target_is_ref_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_field" &&
		((node.target as AccessNode).access as AccessFieldNode).type?.is_ref;

	if (target_is_ref_access) {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const final_offset = get_field_offset(access_field.type?.name || "", access_field.name, status);
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
		}
		return;
	}

	const target_is_class_var =
		node.target.node_type === "value" &&
		!!status.structs.find((s) => s.name === target_type?.name && s.is_class);

	if (target_is_class_var) {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else {
			emit_var_load(status, "x0", name, 8);
		}
		const final_offset = get_field_offset(target_type?.name || "", access_field.name, status);
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
		}
		return;
	}

	// Get base address into x0
	if (base.node_type === "value") {
		const name = (base as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x0", name);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(base, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	const field_type_obj = resolve_field_type(access_field, target_type?.name, status);
	const resolved_field_type = field_type_obj?.name || "";
	const field_is_struct =
		!!resolved_field_type &&
		!field_type_obj?.is_ref &&
		!field_type_obj?.is_nullable &&
		is_struct_type(resolved_field_type, status);

	if (field_is_struct) {
		if (offset > 0) {
			status.code += `add x0, x0, #${offset}\n`;
		}
		return;
	}

	const size = aarch64_size(resolved_field_type);
	const signed =
		resolved_field_type.startsWith("int") ||
		resolved_field_type === "float" ||
		resolved_field_type === "float32" ||
		resolved_field_type === "float64";
	if (size === 1) {
		status.code += signed ? `ldrsb x0, [x0, #${offset}]\n` : `ldrb w0, [x0, #${offset}]\n`;
	} else if (size === 4) {
		status.code += signed ? `ldrsw x0, [x0, #${offset}]\n` : `ldr w0, [x0, #${offset}]\n`;
	} else {
		status.code += `ldr x0, [x0, #${offset}]\n`;
	}
}

function build_access_method(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
) {
	let target_type = type_from_value_node(node.target);
	if (!target_type?.name && node.target.node_type === "access") {
		const resolved = resolve_access_type(node.target as AccessNode, status);
		if (resolved) target_type = resolved;
	}
	if (!target_type?.name && node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		if (name === "self" && status.current_struct) {
			target_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(name)) {
			target_type = status.variable_types.get(name)!;
		} else {
			const decl = status.scoped_declarations.findLast((d) => d.name === name);
			if (decl?.type?.name) {
				target_type = decl.type;
			}
		}
	}
	const target_name =
		node.target.node_type === "value" ? (node.target as ValueNode).value : target_type?.name;
	const enum_node = status.enums.find((e) => e.name === target_name);
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === access_func.name);
		if (enum_case) {
			const case_index = enum_node.cases.indexOf(enum_case);
			if (enum_node.has_associated_data) {
				const enum_size = get_enum_size(target_name!, status);
				const temp_name = `_enum_${access_temp_counter++}`;
				const temp_offset = allocate_stack_space(status, enum_size);
				status.stack_offsets!.set(temp_name, temp_offset);
				status.code += `add x0, x29, #${temp_offset}\n`;
				status.code += `mov x1, #${case_index}\n`;
				status.code += `str x1, [x0]\n`;
				let payload_offset = 8;
				for (let i = access_func.params.length - 1; i >= 0; i--) {
					build_node(access_func.params[i], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					const param_size = aarch64_size(enum_case.params[i].type.name);
					const abs_offset = temp_offset + payload_offset;
					if (param_size === 1) {
						status.code += `strb w0, [x29, #${abs_offset}]\n`;
					} else if (param_size === 4) {
						status.code += `str w0, [x29, #${abs_offset}]\n`;
					} else {
						status.code += `str x0, [x29, #${abs_offset}]\n`;
					}
					payload_offset += param_size;
				}
				status.code += `add x0, x29, #${temp_offset}\n`;
			} else {
				status.code += `mov x0, #${case_index}\n`;
			}
			return;
		}
	}

	if (
		access_func.name === "to_string" &&
		(status.enums.find((e) => e.name === target_type.name) ||
			status.bitsets.find((b) => b.name === target_type.name))
	) {
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const paramReg = get_param_reg(name, status);
			if (paramReg) {
				if (paramReg !== "x0") {
					status.code += `mov x0, ${paramReg}\n`;
				}
			} else {
				emit_var_address(status, "x0", name);
			}
			status.code += `ldr x0, [x0]\n`;
		} else {
			build_node(node.target, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}
		status.code += `bl int_to_string\n`;
		status.last_result_is_heap = true;
		return;
	}

	if (
		access_func.name === "to_string" &&
		target_type.is_array &&
		target_type.name === "char" &&
		target_type.length
	) {
		build_char_array_to_string(node, (target_type.length as ValueNode).value, status);
		status.last_result_is_heap = true;
		return;
	}

	if (access_func.name === "to_string" && target_type.is_array && target_type.length) {
		build_int_array_to_string(node, target_type, status);
		status.last_result_is_heap = true;
		return;
	}

	// String.length() — method call form of the string.length property → strlen
	if (
		target_type.name === "string" &&
		access_func.name === "length" &&
		access_func.params.length === 0
	) {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `bl _strlen\n`;
		return;
	}

	// Inline array .at() and .set() to use element-size-aware load/store
	// Only inline for: value targets (not class arrays) and fixed-size struct field targets
	if (target_type.is_array && (access_func.name === "at" || access_func.name === "set")) {
		const elem_type_name = target_type.name;
		const elem_struct = status.structs.find((s) => s.name === elem_type_name && !s.is_simple_type);
		const is_struct_field_target =
			node.target.node_type === "access" &&
			(node.target as AccessNode).access.node_type === "access_field";
		// Fixed-size fields have a length with a real source position (start >= 0).
		// Dynamic arrays (e.g. constructed at runtime) use length.start = -1 and are stored
		// as a pointer to heap data, so they can't be inlined like inline array fields.
		const length_has_source = !!target_type.length && (target_type.length.start ?? -1) >= 0;
		const is_fixed_size_field = is_struct_field_target && length_has_source;
		const can_inline =
			!elem_struct?.is_class && (node.target.node_type === "value" || is_fixed_size_field);
		if (can_inline) {
			const elem_size = elem_struct
				? get_struct_size(elem_type_name, status)
				: aarch64_size(elem_type_name);
			const elem_signed =
				!elem_struct &&
				elem_type_name.startsWith("int") &&
				elem_type_name !== "int8" &&
				elem_type_name !== "int16" &&
				elem_type_name !== "int32";

			// The inlined .at()/.set() below uses x9 (caller-saved scratch) for
			// the array base, avoiding the per-access x19 save/restore overhead.
			// For .at() (loads), the index is evaluated first into x1, then the
			// base is computed into x9 (doesn't clobber x1). For .set() (stores),
			// we still need x19 save/restore because both index and value must be
			// evaluated and expression evaluation can clobber caller-saved regs.
			const use_fast_path = access_func.name === "at";

			if (use_fast_path) {
				// .at(): evaluate index → x1, compute base → x9, load
				if (access_func.params.length > 0) {
					build_node(access_func.params[0], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x1, x0\n`;
				}
				// Build target (array base) into x9
				if (node.target.node_type === "value") {
					const name = (node.target as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						status.code += `mov x9, ${paramReg}\n`;
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x9", name);
					} else if (status.heap_array_vars?.has(name)) {
						emit_var_address(status, "x9", name);
						status.code += `ldr x9, [x9]\n`;
						status.code += `add x9, x9, #8\n`;
					} else if (
						status.function_array_params?.has(name) ||
						status.function_variadic_params?.has(name)
					) {
						emit_var_address(status, "x9", name);
						status.code += `ldr x9, [x9]\n`;
					} else {
						emit_var_address(status, "x9", name);
					}
				} else if (is_fixed_size_field) {
					const inner_access = node.target as AccessNode;
					const inner_field = inner_access.access as AccessFieldNode;
					const inner_base = inner_access.target;
					const inner_target_type = type_from_value_node(inner_base);
					const field_offset = get_field_offset(
						inner_target_type?.name || "",
						inner_field.name,
						status,
					);
					if (inner_base.node_type === "value") {
						const base_name = (inner_base as ValueNode).value;
						const bpReg = get_param_reg(base_name, status);
						if (bpReg) {
							status.code += `mov x9, ${bpReg}\n`;
						} else if (is_local_ref_var(base_name, status)) {
							emit_deref_var_address(status, "x9", base_name);
						} else {
							emit_var_address(status, "x9", base_name);
						}
					} else {
						build_node(inner_base, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						status.code += `mov x9, x0\n`;
					}
					if (field_offset > 0) {
						status.code += `add x9, x9, #${field_offset}\n`;
					}
				}
				// Load element
				if (elem_struct) {
					if (elem_size === 8) {
						status.code += `add x0, x9, x1, lsl #3\n`;
					} else {
						status.code += `mov x2, #${elem_size}\n`;
						status.code += `mul x1, x1, x2\n`;
						status.code += `add x0, x9, x1\n`;
					}
				} else {
					if (elem_size === 8) {
						status.code += `ldr x0, [x9, x1, lsl #3]\n`;
					} else {
						status.code += `mov x2, #${elem_size}\n`;
						status.code += `mul x1, x1, x2\n`;
						if (elem_size === 1) {
							status.code += elem_signed ? `ldrsb x0, [x9, x1]\n` : `ldrb w0, [x9, x1]\n`;
						} else if (elem_size === 2) {
							status.code += elem_signed ? `ldrsh x0, [x9, x1]\n` : `ldrh w0, [x9, x1]\n`;
						} else if (elem_size === 4) {
							status.code += elem_signed ? `ldrsw x0, [x9, x1]\n` : `ldr w0, [x9, x1]\n`;
						} else {
							status.code += `ldr x0, [x9, x1]\n`;
						}
					}
				}
				return;
			}

			// .set(): still uses x19 save/restore (both index and value params)
			status.code += `str x19, [sp, #-16]!\n`;

			// Build target (array pointer) into x19
			if (node.target.node_type === "value") {
				const name = (node.target as ValueNode).value;
				const paramReg = get_param_reg(name, status);
				if (paramReg) {
					status.code += `mov x19, ${paramReg}\n`;
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x19", name);
				} else if (status.heap_array_vars?.has(name)) {
					// Heap-allocated array: variable stores a heap pointer with an 8-byte
					// length prefix. Dereference and skip the prefix to get the first element.
					emit_var_address(status, "x19", name);
					status.code += `ldr x19, [x19]\n`;
					status.code += `add x19, x19, #8\n`;
				} else if (
					status.function_array_params?.has(name) ||
					status.function_variadic_params?.has(name)
				) {
					// Array passed as a param: variable stores a pointer to raw data (no prefix)
					emit_var_address(status, "x19", name);
					status.code += `ldr x19, [x19]\n`;
				} else {
					// Local var/const array: data is inline, emit_var_address points to first element
					emit_var_address(status, "x19", name);
				}
			} else if (is_fixed_size_field) {
				// Fixed-size struct field array (e.g., h.args.at(0)): compute field address
				const inner_access = node.target as AccessNode;
				const inner_field = inner_access.access as AccessFieldNode;
				const inner_base = inner_access.target;
				const inner_target_type = type_from_value_node(inner_base);
				const field_offset = get_field_offset(
					inner_target_type?.name || "",
					inner_field.name,
					status,
				);

				if (inner_base.node_type === "value") {
					const base_name = (inner_base as ValueNode).value;
					emit_var_address(status, "x19", base_name);
				} else {
					build_node(inner_base, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x19, x0\n`;
				}
				if (field_offset > 0) {
					status.code += `add x19, x19, #${field_offset}\n`;
				}
			}
			// Build index argument into x1
			if (access_func.params.length > 0) {
				build_node(access_func.params[0], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `mov x1, x0\n`;
			}

			if (access_func.name === "at") {
				if (elem_struct) {
					// Struct element: compute address (base + index * elem_size), return pointer
					if (elem_size === 8) {
						status.code += `add x0, x19, x1, lsl #3\n`;
					} else {
						status.code += `mov x2, #${elem_size}\n`;
						status.code += `mul x1, x1, x2\n`;
						status.code += `add x0, x19, x1\n`;
					}
				} else {
					// Simple element: compute offset and load value
					if (elem_size === 8) {
						status.code += `ldr x0, [x19, x1, lsl #3]\n`;
					} else {
						status.code += `mov x2, #${elem_size}\n`;
						status.code += `mul x1, x1, x2\n`;
						if (elem_size === 1) {
							status.code += elem_signed ? `ldrsb x0, [x19, x1]\n` : `ldrb w0, [x19, x1]\n`;
						} else if (elem_size === 2) {
							status.code += elem_signed ? `ldrsh x0, [x19, x1]\n` : `ldrh w0, [x19, x1]\n`;
						} else if (elem_size === 4) {
							status.code += elem_signed ? `ldrsw x0, [x19, x1]\n` : `ldr w0, [x19, x1]\n`;
						} else {
							status.code += `ldr x0, [x19, x1]\n`;
						}
					}
				}
			} else {
				// set(): build value into x2, compute offset and store
				if (access_func.params.length > 1) {
					build_node(access_func.params[1], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x2, x0\n`;
				}
				if (elem_struct) {
					// Struct element: x2 is address of value, memcpy to computed address
					if (elem_size === 8) {
						status.code += `add x0, x19, x1, lsl #3\n`;
					} else {
						status.code += `mov x3, #${elem_size}\n`;
						status.code += `mul x1, x1, x3\n`;
						status.code += `add x0, x19, x1\n`;
					}
					status.code += `mov x1, x2\n`;
					status.code += `mov x2, #${elem_size}\n`;
					status.code += `bl _memcpy\n`;
				} else {
					if (elem_size === 8) {
						status.code += `str x2, [x19, x1, lsl #3]\n`;
					} else {
						status.code += `mov x3, #${elem_size}\n`;
						status.code += `mul x1, x1, x3\n`;
						if (elem_size === 1) {
							status.code += `strb w2, [x19, x1]\n`;
						} else if (elem_size === 2) {
							status.code += `strh w2, [x19, x1]\n`;
						} else if (elem_size === 4) {
							status.code += `str w2, [x19, x1]\n`;
						} else {
							status.code += `str x2, [x19, x1]\n`;
						}
					}
				}
			}
			status.code += `ldr x19, [sp], #16\n`;
			return;
		}
	}

	// Inline Buffer.load_int/store_int/load/store/load_float/store_float
	// to direct strided loads/stores, bypassing the inline-method expansion
	// overhead (self save/restore + x19 save/restore = ~5 extra instructions
	// per access). This is the single biggest codegen win for array-heavy
	// benchmarks (nsieve, knucleotide, spectral-norm, lru).
	if (target_type.name === "Buffer") {
		const method = access_func.name;

		// Invalidate data-pointer cache when a resize/alloc method is called
		// on a Buffer — realloc may move the data pointer, making any cached
		// value in a callee-saved register stale.
		const resize_methods = new Set([
			"grow_int",
			"grow",
			"grow_T",
			"grow_float",
			"alloc_int",
			"alloc",
			"alloc_T",
			"alloc_float",
		]);
		if (resize_methods.has(method) && status.buffer_data_cache) {
			const t = node.target;
			let key: string | null = null;
			if (t.node_type === "value") {
				key = (t as ValueNode).value;
			} else if (
				t.node_type === "access" &&
				(t as AccessNode).access.node_type === "access_field"
			) {
				const inner = t as AccessNode;
				if (inner.target.node_type === "value") {
					key = `${(inner.target as ValueNode).value}.${(inner.access as AccessFieldNode).name}`;
				}
			}
			if (key) status.buffer_data_cache.delete(key);
		}

		const buffer_load_methods = new Set(["load_int", "load", "load_float"]);
		const buffer_store_methods = new Set(["store_int", "store", "store_float", "store_or_int"]);
		const is_buf_load = buffer_load_methods.has(method);
		const is_buf_store = buffer_store_methods.has(method);

		if (is_buf_load || is_buf_store) {
			// Element size: load/store = 4 bytes (uint32), load_int/store_int/
			// load_float/store_float/store_or_int = 8 bytes (long/double).
			// store_or_int treats data as long* (8-byte stride, see Buffer.echo).
			const elem_bytes = method === "load" || method === "store" ? 4 : 8;
			const shift = elem_bytes === 8 ? 3 : 2;
			const is_float = method === "load_float" || method === "store_float";

			// Compute a cache key for the Buffer target so we can reuse
			// a loop-invariant data pointer across iterations.
			function buf_cache_key(): string | null {
				const t = node.target;
				if (t.node_type === "value") {
					return (t as ValueNode).value;
				}
				if (t.node_type === "access" && (t as AccessNode).access.node_type === "access_field") {
					const inner = t as AccessNode;
					const inner_field = inner.access as AccessFieldNode;
					if (inner.target.node_type === "value") {
						return `${(inner.target as ValueNode).value}.${inner_field.name}`;
					}
				}
				return null;
			}

			// Try to allocate a callee-saved register for caching.
			const CALLEE = ["x23", "x24", "x25", "x26", "x27", "x28"];
			function alloc_cache_reg(): string | null {
				const used = new Set(status.register_allocations?.values() ?? []);
				const cached_regs = new Set(status.buffer_data_cache?.values() ?? []);
				const fn_used = status.callee_saved_regs_used ?? new Set<string>();
				for (const r of CALLEE) {
					if (!used.has(r) && !cached_regs.has(r) && !fn_used.has(r)) return r;
				}
				return null;
			}

			// Returns the register holding the Buffer.data pointer,
			// emitting code to load it if not cached.
			function get_data_ptr_reg(): string {
				const key = buf_cache_key();
				if (key && status.buffer_data_cache?.has(key)) {
					return status.buffer_data_cache.get(key)!;
				}
				// Compute the data pointer into x9
				emit_buf_addr_to_x9();
				status.code += `ldr x9, [x9, #8]\n`;
				// LICM caching disabled — causes register conflicts in nested loops
				// where inner-loop promoted vars / caches clobber the outer loop's
				// cached data-ptr register. Needs proper save/restore of cache
				// registers at loop boundaries. TODO: fix and re-enable.
				if (false && key && status.function_return_label) {
					const cache_reg = alloc_cache_reg();
					if (cache_reg) {
						status.code += `mov ${cache_reg}, x9\n`;
						if (!status.buffer_data_cache) status.buffer_data_cache = new Map();
						status.buffer_data_cache.set(key, cache_reg);
						if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
						status.callee_saved_regs_used.add(cache_reg);
						return cache_reg;
					}
				}
				return "x9";
			}

			// Emit the Buffer struct address into x9.
			function emit_buf_addr_to_x9() {
				if (node.target.node_type === "value") {
					const name = (node.target as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						status.code += `mov x9, ${paramReg}\n`;
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x9", name);
					} else {
						emit_var_address(status, "x9", name);
					}
				} else if (
					node.target.node_type === "access" &&
					(node.target as AccessNode).access.node_type === "access_field"
				) {
					const inner = node.target as AccessNode;
					const inner_field = inner.access as AccessFieldNode;
					const inner_base_type = type_from_value_node(inner.target);
					const foff = get_field_offset(inner_base_type?.name || "", inner_field.name, status);
					if (inner.target.node_type === "value") {
						const bname = (inner.target as ValueNode).value;
						const bpReg = get_param_reg(bname, status);
						if (bpReg) {
							status.code += `mov x9, ${bpReg}\n`;
						} else if (is_local_ref_var(bname, status)) {
							emit_deref_var_address(status, "x9", bname);
						} else {
							emit_var_address(status, "x9", bname);
						}
					} else {
						build_node(inner.target, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						status.code += `mov x9, x0\n`;
					}
					if (foff > 0) {
						status.code += `add x9, x9, #${foff}\n`;
					}
				} else {
					build_node(node.target, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x9, x0\n`;
				}
			}

			if (is_buf_load) {
				// Evaluate index → x1
				if (access_func.params.length > 0) {
					build_node(access_func.params[0], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x1, x0\n`;
				}
				// Get data pointer (cached or freshly loaded)
				const data_reg = get_data_ptr_reg();
				// Strided load
				if (is_float) {
					status.code += `ldr d0, [${data_reg}, x1, lsl #${shift}]\n`;
				} else if (elem_bytes === 8) {
					status.code += `ldr x0, [${data_reg}, x1, lsl #3]\n`;
				} else {
					status.code += `ldr w0, [${data_reg}, x1, lsl #2]\n`;
				}
			} else {
				// Store: evaluate index (push), value (→x2), pop index (→x1)
				build_node(access_func.params[0], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `str x0, [sp, #-16]!\n`;
				build_node(access_func.params[1], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `mov x2, x0\n`;
				status.code += `ldr x1, [sp], #16\n`;
				// Get data pointer (cached or freshly loaded)
				const data_reg = get_data_ptr_reg();
				// Strided store
				if (method === "store_or_int") {
					if (elem_bytes === 8) {
						status.code += `ldr x0, [${data_reg}, x1, lsl #3]\n`;
						status.code += `orr x2, x0, x2\n`;
						status.code += `str x2, [${data_reg}, x1, lsl #3]\n`;
					} else {
						status.code += `ldr w0, [${data_reg}, x1, lsl #2]\n`;
						status.code += `orr w2, w0, w2\n`;
						status.code += `str w2, [${data_reg}, x1, lsl #2]\n`;
					}
				} else if (is_float) {
					status.code += `str d0, [${data_reg}, x1, lsl #${shift}]\n`;
				} else if (elem_bytes === 8) {
					status.code += `str x2, [${data_reg}, x1, lsl #3]\n`;
				} else {
					status.code += `str w2, [${data_reg}, x1, lsl #2]\n`;
				}
			}
			return;
		}
	}

	let mono_struct_name = target_type.is_array
		? "Array_" + target_type.name
		: target_type.type_args?.length
			? target_type.name + "_" + target_type.type_args.map((t) => t.name).join("_")
			: target_type.name;
	// Static calls on a generic type without explicit type args (e.g.
	// `Array.with(0, n)`) resolve to the generic name (`Array`), for which no
	// monomorphized struct exists. Find the specialized struct that actually
	// defines the method (e.g. `Array_int`), mirroring the C backend.
	if (
		!access_func.mangled_name &&
		mono_struct_name &&
		!status.structs.find((s) => s.name === mono_struct_name && !s.is_generic)
	) {
		const specialized = status.structs.find(
			(s) =>
				s.name.startsWith(mono_struct_name + "_") &&
				!s.is_generic &&
				s.functions.find((f) => f.name === access_func.name),
		);
		if (specialized) mono_struct_name = specialized.name;
	}
	const method_name =
		access_func.mangled_name || `${mono_struct_name}_${access_func.name.replace(/#/g, "")}`;

	// Check if method returns a struct
	const return_struct = status.structs.find(
		(s) => s.name === access_func.type.name && !s.is_simple_type && !s.is_class,
	);

	let temp_addr = "";
	let temp_offset = 0;
	if (return_struct) {
		temp_addr = `_access_temp_${access_temp_counter++}`;
		temp_offset = allocate_stack_space(status, get_struct_size(access_func.type.name, status));
		status.stack_offsets!.set(temp_addr, temp_offset);
		status.code += `add x8, x29, #${temp_offset}\n`;
	}

	if (!access_func.is_static) {
		// Instance method: load target into x0 (self)
		// For simple types, pass value; for structs, pass address
		const target_is_simple = !status.structs.find(
			(s) => s.name === target_type.name && !s.is_simple_type,
		);
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const paramReg = get_param_reg(name, status);
			const is_literal_value =
				/^(\+|-)?\d+(\.\d+)?$/.test(name) || name === "true" || name === "false";
			if (paramReg) {
				if (paramReg !== "x0") {
					status.code += `mov x0, ${paramReg}\n`;
				}
			} else if (is_literal_value || (name.startsWith("'") && name.endsWith("'"))) {
				build_node(node.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			} else {
				const has_stack_offset = status.stack_offsets?.has(name);
				if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
				// Heap-allocated arrays store a heap pointer with an 8-byte length prefix.
				// Function array params store a pointer to raw data (no prefix).
				if (
					target_type.is_array &&
					status.heap_array_vars?.has(name) &&
					!is_local_ref_var(name, status)
				) {
					status.code += `ldr x0, [x0]\n`;
					status.code += `add x0, x0, #8\n`;
				} else if (
					target_type.is_array &&
					(status.function_array_params?.has(name) || status.function_variadic_params?.has(name)) &&
					!is_local_ref_var(name, status)
				) {
					status.code += `ldr x0, [x0]\n`;
				} else if (
					target_is_simple &&
					(target_type.name !== "string" || has_stack_offset) &&
					!is_local_ref_var(name, status)
				) {
					const size = aarch64_size(target_type.name);
					const signed =
						target_type.name.startsWith("int") ||
						target_type.name === "float" ||
						target_type.name === "float32" ||
						target_type.name === "float64";
					if (size === 1) {
						status.code += signed ? `ldrsb x0, [x0]\n` : `ldrb w0, [x0]\n`;
					} else if (size === 4) {
						status.code += signed ? `ldrsw x0, [x0]\n` : `ldr w0, [x0]\n`;
					} else {
						status.code += `ldr x0, [x0]\n`;
					}
				}
			}
		} else if (!target_is_simple && node.target.node_type === "access") {
			const access_target = node.target as AccessNode;
			if (access_target.access.node_type === "access_field") {
				const offset = compute_field_offset(access_target, status);
				const base = get_base_target(access_target);
				if (base.node_type === "value") {
					const name = (base as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						if (paramReg !== "x0") {
							status.code += `mov x0, ${paramReg}\n`;
						}
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x0", name);
					} else {
						emit_var_address(status, "x0", name);
					}
				} else {
					build_node(base, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
				}
				if (offset > 0) {
					status.code += `add x0, x0, #${offset}\n`;
				}
			} else {
				build_node(node.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}
		} else {
			build_node(node.target, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}
	}

	const needs_self_save = !access_func.is_static && access_func.params.length > 0;
	if (needs_self_save) {
		status.code += `str x0, [sp, #-16]!\n`;
	}

	// Evaluate params
	const param_regs = access_func.is_static
		? ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"]
		: ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const start_idx = 0;
	for (let i = access_func.params.length - 1; i >= 0; i--) {
		const param = access_func.params[i];
		const is_ref_param = access_func.ref_param_indices?.includes(i);
		const param_type = (param as any).type?.name || "";
		const is_struct = is_struct_type(param_type, status);
		if (is_ref_param) {
			emit_address_of(param, status);
		} else if (is_struct) {
			if (param.node_type === "value") {
				const name = (param as ValueNode).value;
				const paramReg = status.function_param_regs?.get(name);
				if (paramReg) {
					if (paramReg !== "x0") {
						status.code += `mov x0, ${paramReg}\n`;
					}
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
			} else {
				build_node(param, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}
		} else {
			build_node(param, status);
		}
		const reg = param_regs[start_idx + i];
		if (reg && reg !== "x0") {
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `mov ${reg}, x0\n`;
		}
	}

	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	if (needs_self_save) {
		status.code += `ldr x0, [sp], #16\n`;
	}

	const target_struct = status.structs.find((s) => s.name === mono_struct_name);
	const inline_func = target_struct?.functions.find(
		(f) =>
			f.is_inline &&
			f.name === access_func.name &&
			(access_func.mangled_name
				? mangled_label(f, mono_struct_name) === access_func.mangled_name
				: true),
	);

	if (inline_func) {
		build_inline_method(target_struct!, inline_func, status);
	} else {
		status.code += `bl ${method_name}\n`;
	}

	if (access_func.mov_param_indices?.length) {
		for (const idx of access_func.mov_param_indices) {
			const param = access_func.params[idx];
			if (param) {
				mark_moved_if_struct(param, status);
			}
		}
	}

	if (method_name.endsWith("_to_string") && method_name !== "string_to_string") {
		status.last_result_is_heap = true;
	}

	if (status.heap_returning_functions?.has(method_name)) {
		status.last_result_is_heap = true;
	}

	if (return_struct) {
		status.code += `add x0, x29, #${temp_offset}\n`;
	}
}

function build_int_array_to_string(node: AccessNode, target_type: Type, status: BuildStatus) {
	const length = parseInt((target_type.length as ValueNode).value);
	const element_size = aarch64_size(target_type.name);

	// Get array base address into x19
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	// Save x19, x20
	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `str x20, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;

	// Allocate result buffer - estimate 20 bytes per int element
	const buf_size = Math.max(length * 20, 32);
	status.code += `mov x0, #${buf_size}\n`;
	emit_malloc(status);
	status.code += `mov x20, x0\n`;

	// Zero out the buffer
	status.code += `strb wzr, [x20]\n`;

	// Loop through elements
	for (let i = 0; i < length; i++) {
		// Load element
		const offset = i * element_size;
		if (element_size === 1) {
			status.code += `ldrb w0, [x19, #${offset}]\n`;
			status.code += `uxtb w0, w0\n`;
		} else {
			status.code += `ldr x0, [x19, #${offset}]\n`;
		}

		// Call int_to_string (or appropriate to_string)
		const to_string_fn = `${target_type.name}_to_string`;
		status.code += `bl ${to_string_fn}\n`;

		// Concatenate: strcat(x20, x0)
		status.code += `str x0, [sp, #-16]!\n`;
		status.code += `mov x1, x0\n`;
		status.code += `mov x0, x20\n`;
		status.code += `bl _strcat\n`;
		status.code += `ldr x0, [sp], #16\n`;
		emit_free(status);
	}

	// Return result in x0
	status.code += `mov x0, x20\n`;
	status.code += `ldr x20, [sp], #16\n`;
	status.code += `ldr x19, [sp], #16\n`;
}

function build_char_array_to_string(node: AccessNode, length: string, status: BuildStatus) {
	const len = parseInt(length);

	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;
	status.code += `mov x0, #${len + 1}\n`;
	emit_malloc(status);

	for (let i = 0; i < len; i++) {
		status.code += `ldrb w1, [x19, #${i}]\n`;
		status.code += `strb w1, [x0, #${i}]\n`;
	}
	status.code += `strb wzr, [x0, #${len}]\n`;
	status.code += `ldr x19, [sp], #16\n`;
}

function resolve_access_type(node: AccessNode, status: BuildStatus): Type | null {
	const inner = node.access;
	if (inner.node_type !== "access_field") return null;
	const field_name = (inner as AccessFieldNode).name;

	let base_type: Type | null = null;
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const vtype = (node.target as ValueNode).type;
		if (vtype?.name) {
			base_type = vtype;
		} else if (name === "self" && status.current_struct) {
			base_type = new Type(status.current_struct.name);
		}
	} else if (node.target.node_type === "access") {
		base_type = resolve_access_type(node.target as AccessNode, status);
	}

	if (!base_type?.name) return null;
	const struct = status.structs.find((s) => s.name === base_type!.name);
	if (!struct) return null;
	const field = struct.fields.find((f) => f.name === field_name);
	return field?.type || null;
}
