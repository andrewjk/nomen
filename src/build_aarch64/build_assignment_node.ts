import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import {
	emit_set_container_class_refs_for_type,
	get_container_class_buffer_field,
} from "./build_declaration_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free } from "./utils/audit.ts";
import {
	anchor_heap_pointer,
	defer_anchor_destroy,
	emit_destroy_for_decl,
	find_anchor_slot,
	mark_moved_if_struct,
} from "./utils/auto_destroy.ts";
import {
	emit_deref_var_address,
	emit_var_address,
	emit_var_load,
	emit_var_store,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import { emit_struct_copy, get_field_offset, get_struct_size } from "./utils/struct_layout.ts";

function is_mutable_param(name: string, status: BuildStatus): boolean {
	return !!(status.function_param_vars?.has(name) || status.function_ref_params?.has(name));
}

function get_store_instruction(size: number): string {
	if (size === 1) return "strb";
	if (size === 4) return "str";
	return "str";
}

function get_store_reg(reg: string, size: number): string {
	if (size === 1 || size === 4) return reg.replace("x", "w");
	return reg;
}

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations.find((d) => d.name === name);
	if (decl) return aarch64_size(decl.type.name);
	return 8;
}

function get_load_instruction(size: number): string {
	if (size === 1) return "ldrb";
	if (size === 4) return "ldr";
	return "ldr";
}

function get_load_reg(reg: string, size: number): string {
	if (size === 1 || size === 4) return reg.replace("x", "w");
	return reg;
}

function emit_compound_op(op: string, status: BuildStatus) {
	if (op === "+=") status.code += `add x0, x1, x0\n`;
	else if (op === "-=") status.code += `sub x0, x1, x0\n`;
	else if (op === "*=") status.code += `mul x0, x1, x0\n`;
}

function get_base_address(access: AccessNode, status: BuildStatus, reg: string) {
	if (access.target.node_type === "value") {
		const name = (access.target as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			if (paramReg !== reg) {
				status.code += `mov ${reg}, ${paramReg}\n`;
			}
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, reg, name);
		} else {
			emit_var_address(status, reg, name);
		}
	} else {
		emit_address_of(access.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		if (reg !== "x0") {
			status.code += `mov ${reg}, x0\n`;
		}
	}
}

function is_struct_type(type: Type | undefined, status: BuildStatus): boolean {
	if (!type?.name) return false;
	return !!status.structs.find((s) => s.name === type.name && !s.is_simple_type);
}

function get_self_param(node: BaseNode): BaseNode | null {
	if (node.node_type === "access" && (node as AccessNode).access.node_type === "access_func") {
		return (node as AccessNode).target;
	}
	if (node.node_type === "func_call") {
		const fc = node as FunctionCallNode;
		const is_init = fc.name.includes("_init") || fc.name.includes("_new");
		if (fc.params.length > 0 && !is_init) {
			return fc.params[0];
		}
	}
	return null;
}

function build_swap(node: AssignmentNode, status: BuildStatus) {
	if (!node.swap) return;
	const rhs = node.right_value;
	if (rhs.node_type === "access" && (rhs as AccessNode).access.node_type === "access_field") {
		const rhs_access = rhs as AccessNode;
		const rhs_field = (rhs_access.access as AccessFieldNode).name;
		const rhs_target_type = type_from_value_node(rhs_access.target);
		const rhs_offset = get_field_offset(rhs_target_type.name, rhs_field, status);

		build_node(node.swap, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `// swap: store replacement to rhs source field\n`;
		status.code += `str x0, [sp, #-16]!\n`;

		get_source_address(rhs_access.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `ldr x1, [sp], #16\n`;
		status.code += `str x1, [x0, #${rhs_offset}]\n`;
	} else if (rhs.node_type === "value") {
		const rhs_value = rhs as ValueNode;
		build_node(node.swap, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `// swap: store replacement to rhs variable\n`;
		status.code += `str x0, [sp, #-16]!\n`;
		const rhs_name = rhs_value.value;
		const paramReg = status.function_param_regs?.get(rhs_name);
		if (paramReg) {
			status.code += `mov x0, ${paramReg}\n`;
		} else {
			emit_var_address(status, "x0", rhs_name);
		}
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `ldr x1, [sp], #16\n`;
		status.code += `str x1, [x0]\n`;
		const rhs_anchor = find_anchor_slot(status, rhs_name);
		if (rhs_anchor !== undefined) {
			status.code += `str x1, [x29, #${rhs_anchor}]\n`;
		}
		status.moved?.delete(rhs_name);
	}
}

function get_source_address(value: BaseNode, status: BuildStatus) {
	if (value.node_type === "value") {
		const name = (value as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			status.code += `mov x0, ${paramReg}\n`;
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x0", name);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(value, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}
}

export default function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
	const rhs_type = type_from_value_node(node.right_value);
	const rhs_is_struct = is_struct_type(rhs_type, status);

	if (node.left_value.node_type === "value") {
		const name = (node.left_value as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);

		if (rhs_is_struct && !node.operator) {
			const struct_size = get_struct_size(rhs_type.name, status);
			const rhs_struct = status.structs.find((s) => s.name === rhs_type.name && s.is_class);
			if (rhs_struct && node.right_value.node_type === "func_call") {
				const func_call = node.right_value as import("../nodes/FunctionCallNode.ts").default;
				const is_constructor = status.structs.find(
					(s) => s.name === func_call.name && !s.is_simple_type,
				);
				if (is_constructor) {
					// The old instance is replaced. Defer its cleanup (destroy +
					// field frees) to scope exit rather than running it now, so
					// that borrows of the old instance's fields stay valid for the
					// rest of the scope. Falls back to eager cleanup when the old
					// value isn't anchored (e.g. a borrowed reference). The
					// replacement is anchored in the variable's declaration frame
					// (returned here) so it survives nested scopes such as loop
					// bodies instead of being freed each iteration.
					const decl_frame = defer_anchor_destroy(status, name, rhs_type.name, rhs_type.type_args);
					if (decl_frame === undefined) {
						emit_destroy_for_decl(status, name, rhs_type.name);
					}
					mark_moved_if_struct(node.right_value, status);
					build_node(node.right_value, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					anchor_heap_pointer(status, name, decl_frame);
					const offset = status.stack_offsets?.get(name);
					if (offset !== undefined) {
						status.code += `str x0, [x29, #${offset}]\n`;
					}
					build_swap(node, status);
					return;
				}
			}
			mark_moved_if_struct(node.right_value, status);
			if (rhs_is_struct && !rhs_struct) {
				const self_param = get_self_param(node.right_value);
				if (self_param && self_param.node_type === "value") {
					const self_name = (self_param as ValueNode).value;
					if (self_name !== name) {
						mark_moved_if_struct(self_param, status);
					}
				}
			}
			const lhs_decl = status.scoped_declarations.find((d) => d.name === name);
			const lhs_type_name = lhs_decl?.type?.name ?? "";
			const needs_pre_destroy =
				rhs_is_struct &&
				!rhs_struct &&
				!paramReg &&
				!is_local_ref_var(name, status) &&
				lhs_type_name;
			if (needs_pre_destroy) {
				emit_destroy_for_decl(status, name, lhs_type_name);
			}
			get_source_address(node.right_value, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			if (paramReg && is_mutable_param(name, status)) {
				if (status.function_ref_params?.has(name)) {
					status.code += `mov ${paramReg}, x0\n`;
				} else {
					status.code += `mov x1, ${paramReg}\n`;
					emit_struct_copy("x0", "x1", 0, struct_size, status);
				}
			} else if (paramReg) {
				status.code += `// cannot assign to const param\n`;
			} else if (is_local_ref_var(name, status)) {
				if (rhs_struct) {
					const anchor = find_anchor_slot(status, name);
					if (anchor !== undefined) {
						const var_offset = status.stack_offsets?.get(name);
						status.code += `str x0, [sp, #-16]!\n`;
						status.code += `ldr x0, [x29, #${anchor}]\n`;
						emit_free(status);
						status.code += `ldr x3, [sp], #16\n`;
						status.code += `str x3, [x29, #${anchor}]\n`;
						if (var_offset !== undefined) {
							status.code += `str x3, [x29, #${var_offset}]\n`;
						} else {
							emit_var_address(status, "x1", name);
							status.code += `str x3, [x1]\n`;
						}
					} else {
						emit_var_address(status, "x1", name);
						status.code += `str x0, [x1]\n`;
					}
				} else {
					emit_var_address(status, "x1", name);
					status.code += `str x0, [x1]\n`;
				}
			} else {
				if (rhs_struct) {
					const anchor = find_anchor_slot(status, name);
					if (anchor !== undefined) {
						const var_offset = status.stack_offsets?.get(name);
						status.code += `str x0, [sp, #-16]!\n`;
						status.code += `ldr x0, [x29, #${anchor}]\n`;
						emit_free(status);
						status.code += `ldr x3, [sp], #16\n`;
						status.code += `str x3, [x29, #${anchor}]\n`;
						if (var_offset !== undefined) {
							status.code += `str x3, [x29, #${var_offset}]\n`;
						} else {
							emit_var_address(status, "x1", name);
							status.code += `str x3, [x1]\n`;
						}
					} else {
						emit_var_address(status, "x1", name);
						emit_struct_copy("x0", "x1", 0, struct_size, status);
					}
				} else {
					emit_var_address(status, "x1", name);
					emit_struct_copy("x0", "x1", 0, struct_size, status);
				}
			}
			build_swap(node, status);
			// When a generic container of class elements is (re)assigned, wire up the
			// element-destroy callback on the freshly stored container's values buffer
			// — the assignment path doesn't go through declaration-init, so without
			// this its elements would leak on destroy. The LHS/RHS type names are the
			// *generic* names here (e.g. "List"), so also try the constructor's
			// monomorphized name (e.g. "List_Animal") and variable_types.
			if (!paramReg && !is_local_ref_var(name, status)) {
				const candidates: string[] = [lhs_type_name, rhs_type.name];
				if (node.right_value.node_type === "func_call") {
					candidates.push((node.right_value as FunctionCallNode).name);
				}
				const vt = status.variable_types?.get(name);
				if (vt?.name) candidates.push(vt.name);
				for (const cand of candidates) {
					const buf_info = get_container_class_buffer_field(cand, status);
					if (buf_info) {
						const var_offset = status.stack_offsets?.get(name);
						if (var_offset !== undefined) {
							emit_set_container_class_refs_for_type(
								status,
								var_offset,
								cand,
								buf_info.field,
								buf_info.elem,
							);
						}
						break;
					}
				}
			}
			return;
		}

		const size = find_var_size(name, status);
		const lhs_decl = status.scoped_declarations.find((d) => d.name === name);
		const lhs_type_name = lhs_decl?.type?.name ?? "";
		const store_op = get_store_instruction(size);
		const store_reg = get_store_reg("x0", size);
		if (paramReg) {
			if (is_mutable_param(name, status)) {
				status.code += `mov x2, ${paramReg}\n`;
				build_node(node.right_value, status);
				if (node.operator) {
					status.code += `\nstr x0, [sp, #-16]!\n`;
					const load_op = get_load_instruction(size);
					const load_reg = get_load_reg("x1", size);
					status.code += `${load_op} ${load_reg}, [x2]\n`;
					status.code += `mov x1, x0\n`;
					status.code += `ldr x0, [sp], #16\n`;
					emit_compound_op(node.operator, status);
				}
				status.code += `\n${store_op} ${store_reg}, [x2]\n`;
			} else {
				build_node(node.right_value, status);
				status.code += `\n// cannot assign to const param\n`;
			}
		} else if (status.function_ref_params?.has(name)) {
			const struct_type = status.structs.find((s) => s.name === lhs_type_name && s.is_class);
			if (struct_type && !node.operator && node.right_value.node_type === "func_call") {
				const func_call = node.right_value as import("../nodes/FunctionCallNode.ts").default;
				const is_constructor = status.structs.find(
					(s) => s.name === func_call.name && !s.is_simple_type,
				);
				if (is_constructor) {
					build_node(node.right_value, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					anchor_heap_pointer(status, name);
					const offset = status.stack_offsets?.get(name);
					if (offset !== undefined) {
						status.code += `str x0, [x29, #${offset}]\n`;
					}
					build_swap(node, status);
					return;
				}
			}
			if (struct_type && !node.operator) {
				status.last_result_is_heap = false;
				build_node(node.right_value, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				// Only anchor when the RHS produced a fresh heap allocation
				// (e.g. a factory function). Borrowed references returned by
				// accessor methods must not be anchored — they are owned
				// elsewhere and anchoring them would cause a double-free.
				if (status.last_result_is_heap) {
					anchor_heap_pointer(status, name);
				}
				const offset = status.stack_offsets?.get(name);
				if (offset !== undefined) {
					status.code += `str x0, [x29, #${offset}]\n`;
				}
				build_swap(node, status);
				return;
			}
			const alloc_reg_a = status.register_allocations?.get(name);
			if (alloc_reg_a) {
				status.code += `mov x2, ${alloc_reg_a}\n`;
			} else {
				const offset = status.stack_offsets?.get(name);
				if (offset !== undefined) {
					status.code += `ldr x2, [x29, #${offset}]\n`;
				} else {
					emit_var_address(status, "x2", name);
					status.code += `ldr x2, [x2]\n`;
				}
			}
			build_node(node.right_value, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `${store_op} ${store_reg}, [x2]\n`;
		} else if (node.operator) {
			const alloc_reg_op = status.register_allocations?.get(name);
			if (alloc_reg_op) {
				status.code += `mov x1, ${alloc_reg_op}\n`;
				status.code += `str x1, [sp, #-16]!\n`;
				build_node(node.right_value, status);
				status.code += `\n`;
				status.code += `ldr x1, [sp], #16\n`;
				emit_compound_op(node.operator, status);
				status.code += `mov ${alloc_reg_op}, x0\n`;
			} else {
				emit_var_address(status, "x1", name);
				const load_op = get_load_instruction(size);
				const load_reg = get_load_reg("x1", size);
				status.code += `${load_op} ${load_reg}, [x1]\n`;
				status.code += `str x1, [sp, #-16]!\n`;
				build_node(node.right_value, status);
				status.code += `\n`;
				status.code += `ldr x1, [sp], #16\n`;
				emit_compound_op(node.operator, status);
				emit_var_address(status, "x1", name);
				status.code += `${store_op} ${store_reg}, [x1]\n`;
			}
		} else {
			const lhs_is_heap = status.heap_strings?.has(name);
			status.last_result_is_heap = false;
			// Build the RHS first: it may read the current (old) value of `name`
			// (e.g. `s = s + "x"`), so the old value must still be alive here.
			build_node(node.right_value, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			// Preserve the freshly computed value across freeing the old value.
			status.code += `str x0, [sp, #-16]!\n`;
			if (lhs_is_heap) {
				emit_var_load(status, "x0", name, 8);
				emit_free(status);
				status.heap_strings!.delete(name);
			}
			status.code += `ldr x0, [sp], #16\n`;
			// last_result_is_heap means the RHS produced a fresh heap string, so the
			// target now owns a heap value. (Don't key off lhs_type_name: inside a
			// loop body the scoped-declaration table is swapped out, so the type
			// can't always be resolved here.)
			if (status.last_result_is_heap) {
				if (!status.heap_strings) status.heap_strings = new Set();
				status.heap_strings.add(name);
			}
			status.code += `\n`;
			emit_var_store(status, "x0", name, size);
		}
	} else if (node.left_value.node_type === "access") {
		const access = node.left_value as AccessNode;
		if (access.access.node_type === "access_field") {
			const field_name = (access.access as AccessFieldNode).name;
			let target_type = type_from_value_node(access.target);
			if (!target_type?.name && access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				if (name === "self" && status.current_struct) {
					target_type = new Type(status.current_struct.name);
				} else if (status.variable_types?.has(name)) {
					target_type = status.variable_types.get(name)!;
				}
			}

			const field_type = (access.access as AccessFieldNode).type;
			const field_is_struct = is_struct_type(field_type, status);

			if (access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				const paramReg = status.function_param_regs?.get(name);
				if (paramReg && name !== "self" && !is_mutable_param(name, status)) {
					status.code += `// cannot assign to field of value param\n`;
					build_swap(node, status);
					return;
				}
			}

			if (field_type?.is_ref) {
				const offset = get_field_offset(target_type.name, field_name, status);

				get_base_address(access, status, "x0");
				status.code += `str x0, [sp, #-16]!\n`;

				get_source_address(node.right_value, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				status.code += `mov x2, x0\n`;
				status.code += `ldr x0, [sp], #16\n`;

				status.code += `str x2, [x0, #${offset}]\n`;
			} else if (field_is_struct && !node.operator) {
				const field_struct = status.structs.find((s) => s.name === field_type!.name);
				if (field_struct?.is_class) {
					const offset = get_field_offset(target_type.name, field_name, status);
					mark_moved_if_struct(node.right_value, status);

					get_base_address(access, status, "x0");
					status.code += `str x0, [sp, #-16]!\n`;
					status.code += `ldr x0, [x0, #${offset}]\n`;
					emit_free(status);

					build_node(node.right_value, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `mov x2, x0\n`;
					status.code += `ldr x0, [sp], #16\n`;

					const field_size = aarch64_size(field_type?.name ?? "int");
					if (field_size === 1) {
						status.code += `strb w2, [x0, #${offset}]\n`;
					} else if (field_size === 2) {
						status.code += `strh w2, [x0, #${offset}]\n`;
					} else if (field_size === 4) {
						status.code += `str w2, [x0, #${offset}]\n`;
					} else {
						status.code += `str x2, [x0, #${offset}]\n`;
					}
				} else {
					const offset = get_field_offset(target_type.name, field_name, status);
					const struct_size = get_struct_size(field_type!.name, status);
					mark_moved_if_struct(node.right_value, status);

					get_base_address(access, status, "x0");
					status.code += `str x0, [sp, #-16]!\n`;

					get_source_address(node.right_value, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `mov x1, x0\n`;
					status.code += `ldr x0, [sp], #16\n`;

					emit_struct_copy("x1", "x0", offset, struct_size, status);
				}
			} else {
				const offset = get_field_offset(target_type.name, field_name, status);

				get_base_address(access, status, "x0");
				status.code += `str x0, [sp, #-16]!\n`;

				build_node(node.right_value, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				mark_moved_if_struct(node.right_value, status);
				status.code += `mov x2, x0\n`;
				status.code += `ldr x0, [sp], #16\n`;

				const field_size = aarch64_size(field_type?.name ?? "int");
				if (field_size === 1) {
					status.code += `strb w2, [x0, #${offset}]\n`;
				} else if (field_size === 2) {
					status.code += `strh w2, [x0, #${offset}]\n`;
				} else if (field_size === 4) {
					status.code += `str w2, [x0, #${offset}]\n`;
				} else {
					status.code += `str x2, [x0, #${offset}]\n`;
				}
			}
		} else {
			build_node(node.right_value, status);
			status.code += `\n// complex assignment\n`;
		}
	} else {
		build_node(node.right_value, status);
		status.code += `\n// complex assignment\n`;
	}

	build_swap(node, status);
}
