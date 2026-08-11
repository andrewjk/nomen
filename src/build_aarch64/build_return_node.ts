import type BuildStatus from "../build_c/BuildStatus.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { resolve_static_value } from "./build_array_values_node.ts";
import { emit_string_array_labels, resolve_array_element } from "./build_declaration_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_malloc } from "./utils/audit.ts";
import {
	emit_destroy_for_decl,
	emit_heap_slots_cleanup_for_return,
	mark_moved_if_struct,
} from "./utils/auto_destroy.ts";
import { is_nullable_struct_type } from "./utils/nullable_struct.ts";
import { allocate_stack_space, emit_var_address, emit_var_store } from "./utils/stack_var.ts";
import { emit_struct_copy, get_struct_size } from "./utils/struct_layout.ts";

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations?.find((d) => d.name === name);
	if (decl?.type?.name) {
		return aarch64_size(decl.type.name);
	}
	return 8;
}

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
	if (node.from_inline) {
		return;
	}

	// For a nullable struct return type, the sret buffer (x8) is sized
	// `struct_size + 8`: bytes [0..struct_size] hold the struct value, the
	// 8-byte word at [struct_size] is the companion `_has` flag (0 = null,
	// 1 = value). The callee writes BOTH through x8 — the caller's local is
	// laid out the same way, so the sret writes land directly on the local's
	// value+flag (no extra copy or hardcoded flag at the call site).
	const returns_nullable_struct = is_nullable_struct_type(status.function_return_type, status);
	const nullable_ret_is_null =
		returns_nullable_struct &&
		(!node.value ||
			(node.value.node_type === "value" && (node.value as ValueNode).value === "null"));
	if (nullable_ret_is_null) {
		// `return null`: write 0 to the flag slot in the sret buffer (the
		// struct value is left uninitialised — the caller won't read it).
		if (status.return_buffer_stack_offset !== undefined) {
			const struct_size = get_struct_size(status.function_return_type!.name, status);
			status.code += `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`;
			status.code += `str xzr, [x8, #${struct_size}]\n`;
		}
		// Run scope-exit cleanup for remaining declarations and jump to the
		// return epilogue (mirrors the void-return path above).
		const finalized = status.moved ?? new Set<string>();
		for (const decl of status.scoped_declarations) {
			if (finalized.has(decl.name)) continue;
			emit_destroy_for_decl(
				status,
				decl.name,
				decl.type.name,
				undefined,
				decl.type.type_args,
				decl.type.is_nullable,
			);
		}
		emit_heap_slots_cleanup_for_return(status);
		status.code += `b ${status.function_return_label}\n`;
		return;
	}

	if (!node.value) {
		if (status.return_assign) {
			const size = find_var_size(status.return_assign, status);
			status.code += `mov x0, #0\n`;
			emit_var_store(status, "x0", status.return_assign, size);
		} else if (status.function_return_label) {
			const finalized = status.moved ?? new Set<string>();
			for (const decl of status.scoped_declarations) {
				if (finalized.has(decl.name)) continue;
				emit_destroy_for_decl(
					status,
					decl.name,
					decl.type.name,
					undefined,
					decl.type.type_args,
					decl.type.is_nullable,
				);
			}
			emit_heap_slots_cleanup_for_return(status);
			status.code += `mov x0, #0\n`;
			status.code += `b ${status.function_return_label}\n`;
		}
		return;
	}

	// Array literal return (e.g. `return [1, 2, 3]`): arrays can't be returned
	// by value, so materialize the literal into a stack buffer first. The
	// generic array-return path below then heap-allocates an Array_<T> buffer
	// and copies the stack data into it (mirrors a `var nums = [1, 2, 3]` decl).
	const return_type_top = status.function_return_type;
	let array_literal_len = 0;
	let array_literal_offset = 0;
	if (return_type_top?.is_array && node.value.node_type === "array") {
		const arr = node.value as ArrayValuesNode;
		array_literal_len = arr.values.length;
		const struct_element = status.structs.find(
			(s) => s.name === return_type_top.name && !s.is_simple_type,
		);
		const element_size = struct_element
			? struct_element.is_class
				? 8
				: get_struct_size(return_type_top.name, status)
			: aarch64_size(return_type_top.name);
		const start = allocate_stack_space(status, 8 + array_literal_len * element_size, element_size);
		status.code += `mov x0, #${array_literal_len}\n`;
		status.code += `str x0, [x29, #${start}]\n`;
		array_literal_offset = start + 8;
		// String elements are stored as pointers to static (.asciz) labels —
		// matching how a `var words = ["a", "b"]` declaration lays them out
		// (rodata, not heap, so the audit stays balanced without per-element frees).
		const is_string_array = return_type_top.name === "string";
		const str_labels = is_string_array
			? emit_string_array_labels(arr.values, status)
			: new Map<string, string>();
		arr.values.forEach((value, i) => {
			const slot = array_literal_offset + i * element_size;
			const raw = resolve_static_value(value, status);
			if (raw !== null && is_string_array) {
				status.code += `adr x0, ${resolve_array_element(raw, str_labels)}\n`;
				status.code += `str x0, [x29, #${slot}]\n`;
			} else if (raw !== null) {
				status.code += `mov x0, #${raw}\n`;
				if (element_size === 1) {
					status.code += `strb w0, [x29, #${slot}]\n`;
				} else if (element_size === 4) {
					status.code += `str w0, [x29, #${slot}]\n`;
				} else {
					status.code += `str x0, [x29, #${slot}]\n`;
				}
			} else {
				build_node(value, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				status.code += `str x0, [x29, #${slot}]\n`;
			}
		});
	}

	if (array_literal_len > 0) {
		status.code += `add x0, x29, #${array_literal_offset}\n`;
	} else {
		// `return T(...) + [ ... ]`: the constructor would normally write
		// straight into the return buffer (struct_return_buffer), bypassing
		// the temp where field overrides are applied. Force the temp path for
		// override constructors so the overrides land on the temp, then the
		// copy below (x0 → return buffer) carries them through.
		const override_ctor =
			node.value?.node_type === "func_call" &&
			!!(node.value as FunctionCallNode).field_overrides?.length;
		const saved_buffer = override_ctor ? status.struct_return_buffer : undefined;
		if (override_ctor) status.struct_return_buffer = undefined;
		build_node(node.value, status);
		if (override_ctor) status.struct_return_buffer = saved_buffer;
	}
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}

	if (status.last_result_is_heap && status.function_return_type?.name === "string") {
		if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
		if (status.current_function_name) {
			status.heap_returning_functions.add(status.current_function_name);
		}
	}

	if (status.function_return_label && status.struct_return_buffer && status.function_return_type) {
		const ret_struct = status.structs.find(
			(s) => s.name === status.function_return_type!.name && !s.is_simple_type && !s.is_class,
		);
		if (ret_struct) {
			if (status.return_buffer_stack_offset !== undefined) {
				status.code += `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`;
			}
			const struct_size = get_struct_size(status.function_return_type!.name, status);
			if (node.value.node_type === "value") {
				const var_name = (node.value as ValueNode).value;
				const paramReg = status.function_param_regs?.get(var_name);
				if (paramReg) {
					emit_struct_copy(paramReg, "x8", 0, struct_size, status);
				} else {
					emit_var_address(status, "x0", var_name);
					emit_struct_copy("x0", "x8", 0, struct_size, status);
				}
			} else {
				emit_struct_copy("x0", "x8", 0, struct_size, status);
			}
			// For a nullable struct return, the sret buffer is sized
			// `struct_size + 8` and the 8-byte word at [struct_size] is the
			// companion `_has` flag. We've just copied the non-null value —
			// write `1` so the caller sees the result as non-null. (The
			// null-return path is handled at the top of this function.)
			if (returns_nullable_struct) {
				status.code += `mov x9, #1\n`;
				status.code += `str x9, [x8, #${struct_size}]\n`;
			}
		}
	}

	if (status.return_assign) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const size = find_var_size(status.return_assign, status);
		emit_var_store(status, "x0", status.return_assign, size);
	} else if (status.function_return_label) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}

		const return_type = status.function_return_type;
		if (return_type?.is_array) {
			const struct_element = status.structs.find(
				(s) => s.name === return_type.name && !s.is_simple_type,
			);
			const element_size = struct_element
				? struct_element.is_class
					? 8
					: get_struct_size(return_type.name, status)
				: aarch64_size(return_type.name);
			const var_name =
				array_literal_len > 0
					? "_return_array"
					: node.value?.node_type === "value"
						? (node.value as any).value
						: undefined;
			const decl =
				var_name && array_literal_len === 0
					? status.scoped_declarations?.find((d) => d.name === var_name)
					: undefined;
			const array_len =
				array_literal_len > 0
					? array_literal_len
					: decl?.value?.node_type === "array"
						? (decl.value as any).values.length
						: decl?.type?.length
							? parseInt((decl.type.length as any).value || "0")
							: 0;
			if (array_literal_len > 0 && !status.stack_offsets?.has("_return_array")) {
				if (!status.stack_offsets) status.stack_offsets = new Map();
				status.stack_offsets.set("_return_array", array_literal_offset);
			}
			const total_size = array_len * element_size;
			if (total_size > 0) {
				status.code += `str x0, [sp, #-16]!\n`;
				status.code += `mov x0, #${8 + total_size}\n`;
				emit_malloc(status);
				status.code += `mov x1, x0\n`;
				status.code += `mov x2, #${array_len}\n`;
				status.code += `str x2, [x1]\n`;
				status.code += `add x1, x1, #8\n`;
				status.code += `ldr x2, [sp]\n`;
				const words = Math.ceil(total_size / 8);
				for (let i = 0; i < words; i++) {
					status.code += `ldr x3, [x2, #${i * 8}]\n`;
					status.code += `str x3, [x1, #${i * 8}]\n`;
				}
				status.code += `add sp, sp, #16\n`;
			}
			if (struct_element?.is_class && var_name) {
				if (!status.moved) status.moved = new Set();
				const offset = status.stack_offsets?.get(var_name) ?? 0;
				for (let i = 0; i < array_len; i++) {
					const anchor_name = `${var_name}_elem_${offset + i * element_size}`;
					status.moved.add(anchor_name);
				}
			}
			// Returning a heap-array VARIABLE (`return dst` where dst is a
			// heap-allocated `Array<T>` from `Array.with(...)`, a call, etc.)
			// transfers buffer ownership to the caller. Mark it moved so the
			// return-path cleanup AND the function's fall-through scope-exit
			// cleanup both skip it — otherwise the buffer is freed while the
			// caller still holds the pointer (a use-after-free that is dead
			// code for an unconditional return but a real double-free for a
			// conditional `if cond { return dst }`). Stack-array / literal
			// returns take the heap-alloc-and-copy path above (total_size > 0)
			// and are unaffected.
			if (var_name && status.heap_array_vars?.has(var_name)) {
				if (!status.moved) status.moved = new Set();
				status.moved.add(var_name);
			}
		}

		mark_moved_if_struct(node.value, status);
		const finalized = status.moved ?? new Set<string>();
		status.code += `str x0, [sp, #-16]!\n`;
		for (const decl of status.scoped_declarations) {
			if (finalized.has(decl.name)) continue;
			emit_destroy_for_decl(
				status,
				decl.name,
				decl.type.name,
				undefined,
				decl.type.type_args,
				decl.type.is_nullable,
			);
		}
		emit_heap_slots_cleanup_for_return(status);
		status.code += `ldr x0, [sp], #16\n`;
		status.code += `b ${status.function_return_label}\n`;
	}
}
