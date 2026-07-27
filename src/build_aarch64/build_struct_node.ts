import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import { check_c_fallback } from "./build_raw_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_field_destroys, has_struct_fields_with_destroy } from "./utils/auto_destroy.ts";
import { is_nullable_struct_type } from "./utils/nullable_struct.ts";
import scan_force_heap_strings from "./utils/scan_force_heap_strings.ts";
import {
	NUM_REG_ARGS,
	overflow_placeholder,
	patch_overflow_placeholders,
} from "./utils/stack_args.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";
import {
	get_field_has_offset,
	get_field_offset,
	get_struct_size,
	get_type_size,
} from "./utils/struct_layout.ts";

function emit_typed_store(
	status: BuildStatus,
	src_reg: string,
	dst_base: string,
	offset: number,
	size: number,
) {
	const wreg = src_reg.replace("x", "w");
	const addr = offset === 0 ? `[${dst_base}]` : `[${dst_base}, #${offset}]`;
	if (size === 1) {
		status.code += `strb ${wreg}, ${addr}\n`;
	} else if (size === 2) {
		status.code += `strh ${wreg}, ${addr}\n`;
	} else if (size === 4) {
		status.code += `str ${wreg}, ${addr}\n`;
	} else {
		status.code += `str ${src_reg}, ${addr}\n`;
	}
}

/**
 * Initialize a nullable struct field's default value, returning true if this
 * field was handled (caller should `continue`). `base_reg` is the struct base
 * register (`x0` for auto-init, `x19` for custom-init).
 */
function init_nullable_field_default(
	node: StructNode,
	field: any,
	base_reg: string,
	status: BuildStatus,
): boolean {
	if (!is_nullable_struct_type(field.type, status)) return false;
	if (!field.value) return false;
	const offset = get_field_offset(node.name, field.name, status);
	const has_offset = get_field_has_offset(node.name, field.name, status);
	const is_null = field.value.node_type === "value" && (field.value as any).value === "null";
	if (is_null) {
		status.code += `str xzr, [${base_reg}, #${has_offset}]\n`;
		return true;
	}
	// Non-null default: build the value (a constructor) and copy it in.
	build_node(field.value, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	// Result address in x0; copy word-by-word into the field.
	const field_size = get_struct_size(field.type.name, status);
	const words = Math.ceil(field_size / 8);
	for (let w = 0; w < words; w++) {
		status.code += `ldr x9, [x0, #${w * 8}]\n`;
		status.code += `str x9, [${base_reg}, #${offset + w * 8}]\n`;
	}
	status.code += `mov x9, #1\n`;
	status.code += `str x9, [${base_reg}, #${has_offset}]\n`;
	return true;
}

export default function build_struct_node(node: StructNode, status: BuildStatus) {
	if (node.is_generic) return;

	const is_nested = !!status.function_return_label;

	let old_code: string | undefined;
	if (is_nested) {
		old_code = status.code;
		status.code = "";
	}

	const custom_init = node.functions.find((f) => f.name === "#init" && f.has_body);

	if (node.is_simple_type) {
		build_struct_functions(node, status);
	} else {
		status.current_struct = node;
		if (!custom_init) {
			build_init_function(node, status);
		}
		build_struct_functions(node, status);
		build_trait_functions(node, status);
		build_struct_traits(node, status);
		const destroy_func = node.functions.find((f) => f.name === "#destroy");
		if (destroy_func) {
			if (!check_c_fallback(destroy_func, node.name, status)) {
				build_destroy_function(node, destroy_func, status);
			}
		} else if (node.is_class) {
			build_auto_destroy_function(node, status);
		} else if (node.traits.length > 0 && has_struct_fields_with_destroy(node, status)) {
			// A trait-conforming value struct that owns heap data through its
			// fields (e.g. `struct Dog : Speaker { var string name }`) needs
			// an auto-generated <Struct>_destroy: when such a struct is boxed
			// into a ClassBuffer<Trait> slot, the per-element destroy
			// dispatches through the vtable to this function. Without it, the
			// destroy slot in the vtable would point to a missing symbol.
			build_auto_destroy_function(node, status);
		}
		status.current_struct = undefined;
	}

	if (is_nested) {
		if (!status.nested_functions) status.nested_functions = "";
		status.nested_functions += status.code;
		status.code = old_code!;
	}
}

function build_destroy_function(node: StructNode, func: FunctionNode, status: BuildStatus) {
	const func_label = `${node.name}_destroy`;

	const old_scoped_declarations = status.scoped_declarations;
	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;

	status.scoped_declarations = [];
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const return_label = `.return_${func_label}`;
	status.function_return_label = return_label;

	const stack_placeholder = `STACK_SIZE_${func_label}`;

	status.code += `.p2align 2\n`;
	status.code += `${func_label}:\n`;
	status.code += `stp x29, x30, [sp, #-16]!\n`;
	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_param_regs.set("self", "x19");

	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	status.buffer_data_cache = undefined;
	build_block_node(func, status);

	// After the user body, recursively destroy all class-typed fields.
	// This ensures that grandchildren (and deeper) are freed, not just
	// direct children.
	if (node.is_class) {
		emit_field_destroys(status, node, "self", undefined, false);
	}

	status.code += `${return_label}:\n`;

	const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
	status.code = status.code.replace(
		`sub sp, sp, #${stack_placeholder}`,
		total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
	);
	if (total_stack > 0) {
		status.code += `add sp, sp, #${total_stack}\n`;
	}

	status.code += `ldr x19, [sp], #16\n`;
	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	status.scoped_declarations = old_scoped_declarations;
	status.function_param_regs = old_param_regs;
	status.function_param_vars = old_param_vars;
	status.function_return_label = old_return_label;
	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
}

function build_auto_destroy_function(node: StructNode, status: BuildStatus) {
	const func_label = `${node.name}_destroy`;

	const old_scoped_declarations = status.scoped_declarations;
	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;

	status.scoped_declarations = [];
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const return_label = `.return_${func_label}`;
	status.function_return_label = return_label;

	const stack_placeholder = `STACK_SIZE_${func_label}`;

	status.code += `.p2align 2\n`;
	status.code += `${func_label}:\n`;
	status.code += `stp x29, x30, [sp, #-16]!\n`;
	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_param_regs.set("self", "x19");

	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	// No user body — just destroy class-typed fields
	emit_field_destroys(status, node, "self", undefined, false);

	status.code += `${return_label}:\n`;

	const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
	status.code = status.code.replace(
		`sub sp, sp, #${stack_placeholder}`,
		total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
	);
	if (total_stack > 0) {
		status.code += `add sp, sp, #${total_stack}\n`;
	}

	status.code += `ldr x19, [sp], #16\n`;
	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	status.scoped_declarations = old_scoped_declarations;
	status.function_param_regs = old_param_regs;
	status.function_param_vars = old_param_vars;
	status.function_return_label = old_return_label;
	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
}

function build_init_function(node: StructNode, status: BuildStatus) {
	const func_name = `${node.name}_init`;
	const required_fields = node.fields.filter((f) => f.value == null);

	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const stack_placeholder = `STACK_SIZE_${func_name}`;

	status.code += `.p2align 2\n`;
	status.code += `${func_name}:\n`;
	status.code += `stp x29, x30, [sp, #-16]!\n`;
	// self lives in x19 across the whole init so a defaulted struct field
	// (e.g. `var Inner child = Inner()`) can run a constructor call without
	// losing the destination pointer — the call sequence clobbers x0 with
	// the return-temp address.
	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;
	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	status.code += `str xzr, [x19]\n`;

	// If the struct conforms to any trait, install its vtable pointer at
	// offset 0 (the reserved VT_SIZE slot) so trait-typed dispatch can resolve
	// the concrete methods/fields. Mirrors the C backend's `self._vt =
	// &_Struct_traits`.
	if (node.traits.length > 0) {
		// adrp+add (not adr): the vtable lives in the __DATA segment, so the
		// cross-section address needs page-relative addressing on Mach-O.
		status.code += `adrp x9, _${node.name}_traits@PAGE\n`;
		status.code += `add x9, x9, _${node.name}_traits@PAGEOFF\n`;
		status.code += `str x9, [x19]\n`;
	}

	const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	for (let i = 0; i < required_fields.length; i++) {
		const field = required_fields[i];
		const offset = get_field_offset(node.name, field.name, status);
		// x19 is the destination (self pointer); field i arrives in slot i+1
		// (x1, x2, …). Slots past x7 arrive in the caller's outgoing stack
		// area; with one callee-saved push (x19) between `stp x29, x30` and
		// `sub sp, sp, #STACK_SIZE`, slot (8+k) lives at the per-arg
		// placeholder offset patched once the local frame size is known.
		const slot = i + 1;
		let src_reg: string;
		if (slot < NUM_REG_ARGS) {
			src_reg = param_regs[i];
		} else {
			const k = slot - NUM_REG_ARGS;
			status.code += `ldr x10, [x29, #${overflow_placeholder(func_name, k)}]\n`;
			src_reg = "x10";
		}
		if (field.type.is_array && field.type.length && (field.type.length.start ?? -1) >= 0) {
			const element_size = aarch64_size(field.type.name);
			const length = parseInt((field.type.length as ValueNode).value || "0");
			for (let e = 0; e < length; e++) {
				const byte_offset = e * element_size;
				status.code += load_element(src_reg, byte_offset, element_size);
				status.code += store_element("x19", offset + byte_offset, element_size);
			}
		} else if (
			!field.type.is_ref &&
			status.structs.find((s) => s.name === field.type.name && !s.is_simple_type && !s.is_class)
		) {
			// Struct/tuple field: copy word-by-word from the param register
			// (which holds a pointer to the struct value). x9 is the copy
			// scratch so we don't clobber the source pointer in src_reg.
			// (Class fields hold a pointer and are handled by the plain store
			// path below.)
			const field_size = get_struct_size(field.type.name, status);
			const words = Math.ceil(field_size / 8);
			for (let w = 0; w < words; w++) {
				status.code += `ldr x9, [${src_reg}, #${w * 8}]\n`;
				status.code += `str x9, [x19, #${offset + w * 8}]\n`;
			}
		} else {
			const field_size = get_type_size(field.type, status);
			emit_typed_store(status, src_reg, "x19", offset, field_size);
		}
	}

	for (const field of node.fields) {
		if (field.value) {
			if (init_nullable_field_default(node, field, "x19", status)) continue;
			const offset = get_field_offset(node.name, field.name, status);
			if (field.value.node_type === "value") {
				const val = (field.value as any).value;
				if (val === "true") {
					status.code += `mov x1, #1\n`;
				} else if (val === "false") {
					status.code += `mov x1, #0\n`;
				} else if (val === "null") {
					status.code += `mov x1, #0\n`;
				} else if (/^(\+|-)*\d+$/.test(val)) {
					status.code += `ldr x1, =${val}\n`;
				} else if (val.startsWith('"')) {
					const label = `_str_${func_name}_${field.name}`;
					status.strings!.set(label, val);
					status.code += `adr x1, ${label}\n`;
				} else {
					status.code += `ldr x1, =${val}\n`;
				}
				emit_typed_store(status, "x1", "x19", offset, get_type_size(field.type, status));
			} else if (field.value.node_type === "func_call") {
				const field_struct = status.structs.find(
					(s) => s.name === field.type.name && !s.is_simple_type,
				);
				if (field_struct) {
					// Run the constructor (e.g. `Inner()`); the call sequence
					// leaves x0 pointing at the return-value temp. Copy the
					// result word-by-word into the field slot. self lives in
					// x19, so it survives the call.
					build_node(field.value, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					const field_size = get_struct_size(field.type.name, status);
					const words = Math.ceil(field_size / 8);
					for (let w = 0; w < words; w++) {
						status.code += `ldr x9, [x0, #${w * 8}]\n`;
						status.code += `str x9, [x19, #${offset + w * 8}]\n`;
					}
				}
			}
		}
	}

	status.code += `.return_${func_name}:\n`;

	const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
	status.code = status.code.replace(
		`sub sp, sp, #${stack_placeholder}`,
		total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
	);
	// Resolve overflow-arg placeholders. The only `str xN, [sp, #-16]!`
	// between `stp x29, x30` and `sub sp, sp, #STACK_SIZE` is the x19 push, so
	// callee_saved_pushes = 1.
	status.code = patch_overflow_placeholders(status.code, func_name, 1, total_stack);
	if (total_stack > 0) {
		status.code += `add sp, sp, #${total_stack}\n`;
	}
	status.code += `ldr x19, [sp], #16\n`;
	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
}

function build_custom_init_function(node: StructNode, func: FunctionNode, status: BuildStatus) {
	const func_name = `${node.name}_init`;

	const old_scoped_declarations = status.scoped_declarations;
	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;

	status.scoped_declarations = [];
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const return_label = `.return_${node.name}_init`;
	status.function_return_label = return_label;

	const stack_placeholder = `STACK_SIZE_${func_name}`;

	status.code += `.p2align 2\n`;
	status.code += `${func_name}:\n`;
	status.code += `stp x29, x30, [sp, #-16]!\n`;

	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	const old_variadic_params = status.function_variadic_params;
	status.function_variadic_params = new Set();

	status.function_param_regs.set("self", "x19");

	for (let i = 0; i < func.params.length; i++) {
		const param = func.params[i];
		if (param.is_self_param) continue;
		if (param.is_variadic) continue;
		status.function_param_vars.add(param.name);
	}

	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	// self occupies x0 (moved to x19 above); custom-init params arrive in
	// x1, x2, ... Variadic params consume two register slots — a hidden
	// `_name_len` count followed by the array pointer — mirroring the
	// regular function-call convention. Params beyond slot 7 (the 8th
	// register slot, since x0 is reserved for self) arrive in the caller's
	// outgoing stack area and are loaded here via per-arg placeholders
	// patched once the local frame size is known.
	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	let param_idx = 1;
	for (let i = 0; i < func.params.length; i++) {
		const param = func.params[i];
		if (param.is_self_param) continue;
		if (param.is_variadic) {
			status.function_variadic_params!.add(param.name);
			const len_offset = allocate_stack_space(status, 8, 8);
			status.stack_offsets!.set(`_${param.name}_len`, len_offset);
			if (param_idx < NUM_REG_ARGS) {
				status.code += `str ${param_regs[param_idx]}, [x29, #${len_offset}]\n`;
			} else {
				const k = param_idx - NUM_REG_ARGS;
				status.code += `ldr x9, [x29, #${overflow_placeholder(func_name, k)}]\n`;
				status.code += `str x9, [x29, #${len_offset}]\n`;
			}
			param_idx++;
		}
		const size = aarch64_size(param.type.name);
		const offset = allocate_stack_space(status, size, size);
		status.stack_offsets!.set(param.name, offset);
		if (param_idx < NUM_REG_ARGS) {
			status.code += `str ${param_regs[param_idx]}, [x29, #${offset}]\n`;
		} else {
			const k = param_idx - NUM_REG_ARGS;
			status.code += `ldr x9, [x29, #${overflow_placeholder(func_name, k)}]\n`;
			if (size === 1) {
				status.code += `strb w9, [x29, #${offset}]\n`;
			} else if (size === 4) {
				status.code += `str w9, [x29, #${offset}]\n`;
			} else {
				status.code += `str x9, [x29, #${offset}]\n`;
			}
		}
		param_idx++;
	}

	// Zero the struct memory
	status.code += `str xzr, [x19]\n`;

	// Install the vtable pointer at offset 0 for trait-conforming structs.
	if (node.traits.length > 0) {
		status.code += `adrp x9, _${node.name}_traits@PAGE\n`;
		status.code += `add x9, x9, _${node.name}_traits@PAGEOFF\n`;
		status.code += `str x9, [x19]\n`;
	}

	// Initialize default field values
	for (const field of node.fields) {
		if (field.value) {
			if (init_nullable_field_default(node, field, "x19", status)) continue;
			const offset = get_field_offset(node.name, field.name, status);
			if (field.value.node_type === "value") {
				const val = (field.value as any).value;
				if (val === "true") {
					status.code += `mov x1, #1\n`;
				} else if (val === "false") {
					status.code += `mov x1, #0\n`;
				} else if (val === "null") {
					status.code += `mov x1, #0\n`;
				} else if (/^(\+|-)*\d+$/.test(val)) {
					status.code += `ldr x1, =${val}\n`;
				} else if (val.startsWith('"')) {
					const label = `_str_${func_name}_${field.name}`;
					status.strings!.set(label, val);
					status.code += `adr x1, ${label}\n`;
				} else {
					status.code += `ldr x1, =${val}\n`;
				}
				emit_typed_store(status, "x1", "x19", offset, get_type_size(field.type, status));
			} else if (field.value.node_type === "func_call") {
				const field_struct = status.structs.find(
					(s) => s.name === field.type.name && !s.is_simple_type,
				);
				if (field_struct) {
					// Run the constructor and copy the return-value temp into
					// the field slot. self lives in x19, so it survives the
					// call (which clobbers x0 with the temp address).
					build_node(field.value, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					const field_size = get_struct_size(field.type.name, status);
					const words = Math.ceil(field_size / 8);
					for (let w = 0; w < words; w++) {
						status.code += `ldr x9, [x0, #${w * 8}]\n`;
						status.code += `str x9, [x19, #${offset + w * 8}]\n`;
					}
				}
			}
		}
	}

	status.buffer_data_cache = undefined;
	build_block_node(func, status);

	status.code += `${return_label}:\n`;

	const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
	status.code = status.code.replace(
		`sub sp, sp, #${stack_placeholder}`,
		total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
	);
	// Patch per-overflow-arg placeholders emitted in the param-loading loop
	// above. self's x19 save is the only `str xN, [sp, #-16]!` between
	// `stp x29, x30` and `sub sp, sp, #STACK_SIZE`, so N = 1.
	status.code = patch_overflow_placeholders(status.code, func_name, 1, total_stack);
	if (total_stack > 0) {
		status.code += `add sp, sp, #${total_stack}\n`;
	}

	status.code += `ldr x19, [sp], #16\n`;
	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	status.scoped_declarations = old_scoped_declarations;
	status.function_param_regs = old_param_regs;
	status.function_param_vars = old_param_vars;
	status.function_variadic_params = old_variadic_params;
	status.function_return_label = old_return_label;
	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
}

function build_struct_functions(node: StructNode, status: BuildStatus) {
	for (const func of node.functions) {
		if (func.name === "#init" && !func.has_body) continue;
		if (func.name === "#init" && func.has_body) {
			if (!check_c_fallback(func, node.name, status)) {
				build_custom_init_function(node, func, status);
			}
			continue;
		}
		if (func.name === "#destroy") continue;
		if (func.is_inline) continue;
		if (check_c_fallback(func, node.name, status)) continue;

		const old_scoped_declarations = status.scoped_declarations;
		const old_stack_size = status.stack_size;
		const old_stack_offsets = status.stack_offsets;
		const old_param_regs = status.function_param_regs;
		const old_param_vars = status.function_param_vars;
		const old_return_label = status.function_return_label;
		const old_force_heap = status.force_heap_strings;

		status.scoped_declarations = [];
		status.stack_size = 0;
		status.stack_offsets = new Map();

		const func_label = is_overloaded(node, func.name)
			? mangled_label(func, node.name)
			: `${node.name}_${func.name.replace(/#/g, "")}`;
		const return_label = `.return_${func_label}`;
		status.function_return_label = return_label;

		const stack_placeholder = `STACK_SIZE_${func_label}`;

		status.code += `.p2align 2\n`;
		status.code += `${func_label}:\n`;
		status.code += `stp x29, x30, [sp, #-16]!\n`;

		const is_self_param = func.params[0]?.is_self_param;
		const self_is_var = is_self_param && func.params[0]?.declaration === "var";
		const needs_x19 = is_self_param && !self_is_var;
		if (needs_x19) {
			status.code += `str x19, [sp, #-16]!\n`;
			status.code += `mov x19, x0\n`;
		}

		const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
		const callee_saved = ["x19", "x20", "x21", "x22"];
		let callee_idx = 0;
		if (needs_x19) {
			callee_idx = 1;
		}

		const old_ref_params = status.function_ref_params;

		status.function_param_regs = new Map();
		status.function_param_vars = new Set();
		status.function_ref_params = new Set();
		status.struct_return_buffer = undefined;

		const return_struct = status.structs.find(
			(s) => s.name === func.return_type?.name && !s.is_simple_type,
		);
		let return_buffer_stack_offset: number | undefined;
		if (return_struct) {
			status.function_return_type = func.return_type;
			status.struct_return_buffer = "x8";
		}

		if (needs_x19) {
			status.function_param_regs.set("self", "x19");
		}

		// Track the AAPCS64 register slot index. self takes slot 0 (whether
		// moved to x19 or, for `var self`, treated as a regular struct param);
		// variadics take 2 slots (count + ptr); every other param takes 1.
		let slot_idx = 0;
		for (let i = 0; i < func.params.length; i++) {
			const param = func.params[i];
			if (param.is_self_param && !self_is_var) {
				slot_idx++;
				continue;
			}
			if (param.is_variadic) {
				slot_idx += 2;
				if (param.declaration === "var") {
					status.function_param_vars.add(param.name);
				}
				if (param.type.is_ref) {
					status.function_ref_params!.add(param.name);
				}
				continue;
			}
			const is_struct_type = !!status.structs.find(
				(s) => s.name === param.type.name && !s.is_simple_type,
			);
			if (is_struct_type && callee_idx < callee_saved.length) {
				const saved_reg = callee_saved[callee_idx++];
				if (saved_reg !== "x19" || !needs_x19) {
					status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				}
				if (slot_idx < NUM_REG_ARGS) {
					status.code += `mov ${saved_reg}, ${param_regs[slot_idx]}\n`;
				} else {
					// Overflow: arg arrived in the caller's outgoing stack
					// area. After the push above, sp = caller_sp - 16 -
					// 16*callee_idx (callee_idx already counts the self/x19
					// push when needs_x19), so the k-th stack arg (slot 8+k)
					// lives at [sp, #(16 + 16*callee_idx + k*8)].
					const k = slot_idx - NUM_REG_ARGS;
					status.code += `ldr ${saved_reg}, [sp, #${16 + 16 * callee_idx + k * 8}]\n`;
				}
				status.function_param_regs.set(param.name, saved_reg);
			} else {
				// Non-struct params will be saved after stack allocation
			}
			if (param.declaration === "var") {
				status.function_param_vars.add(param.name);
			}
			if (param.type.is_ref) {
				status.function_ref_params!.add(param.name);
			}
			const param_struct = status.structs.find((s) => s.name === param.type.name && s.is_class);
			if (param_struct) {
				status.function_ref_params!.add(param.name);
			}
			slot_idx++;
		}

		status.code += `sub sp, sp, #${stack_placeholder}\n`;
		status.code += `mov x29, sp\n`;

		if (return_struct) {
			return_buffer_stack_offset = allocate_stack_space(status, 8, 8);
			status.code += `str x8, [x29, #${return_buffer_stack_offset}]\n`;
			status.return_buffer_stack_offset = return_buffer_stack_offset;
		}

		// Save non-struct params and ref self to stack now that x29 is set.
		// Re-walk the param list with the same slot accounting as the first
		// pass so overflow args (slot >= 8) are pulled from the caller's
		// outgoing stack area via per-arg placeholders.
		let second_slot_idx = 0;
		for (let i = 0; i < func.params.length; i++) {
			const param = func.params[i];
			if (param.is_self_param && !self_is_var) {
				second_slot_idx++;
				continue;
			}
			if (param.is_variadic) {
				second_slot_idx += 2;
				continue;
			}
			const is_struct_type = !!status.structs.find(
				(s) => s.name === param.type.name && !s.is_simple_type,
			);
			if (!is_struct_type) {
				const size = aarch64_size(param.type.name);
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(param.name, offset);
				if (param.is_self_param) {
					// `var self`: self takes slot 0 (in x0) — not a stack arg.
					const save_reg = needs_x19 ? "x19" : param_regs[second_slot_idx];
					status.code += `str ${save_reg}, [x29, #${offset}]\n`;
				} else if (second_slot_idx < NUM_REG_ARGS) {
					const reg = param_regs[second_slot_idx];
					if (size === 1) {
						status.code += `strb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
					} else if (size === 4) {
						status.code += `str ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
					} else {
						status.code += `str ${reg}, [x29, #${offset}]\n`;
					}
				} else {
					const k = second_slot_idx - NUM_REG_ARGS;
					status.code += `ldr x9, [x29, #${overflow_placeholder(func_label, k)}]\n`;
					if (size === 1) {
						status.code += `strb w9, [x29, #${offset}]\n`;
					} else if (size === 4) {
						status.code += `str w9, [x29, #${offset}]\n`;
					} else {
						status.code += `str x9, [x29, #${offset}]\n`;
					}
				}
			}
			second_slot_idx++;
		}

		status.force_heap_strings = scan_force_heap_strings(func.statements);
		status.buffer_data_cache = undefined;
		build_block_node(func, status);

		const loop_regs_used = status.callee_saved_regs_used
			? [...status.callee_saved_regs_used].sort()
			: [];
		status.callee_saved_regs_used = undefined;

		if (loop_regs_used.length > 0) {
			const label = `${func_label}:`;
			const func_start = status.code.indexOf(label);
			const after_prologue =
				func_start !== -1
					? status.code.indexOf(`sub sp, sp, #${stack_placeholder}`, func_start)
					: -1;
			if (after_prologue !== -1) {
				let saves = "";
				for (const reg of loop_regs_used) {
					saves += `str ${reg}, [sp, #-16]!\n`;
				}
				status.code =
					status.code.slice(0, after_prologue) + saves + status.code.slice(after_prologue);
			}
		}

		status.code += `${return_label}:\n`;

		const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
		status.code = status.code.replace(
			`sub sp, sp, #${stack_placeholder}`,
			total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
		);
		// Resolve overflow-arg placeholders emitted in the second pass. The
		// count of `str xN, [sp, #-16]!` pushes between `stp x29, x30` and
		// `sub sp, sp, #STACK_SIZE` is `callee_idx + loop_regs_used.length`
		// (callee_idx already includes the self/x19 push when needs_x19).
		status.code = patch_overflow_placeholders(
			status.code,
			func_label,
			callee_idx + loop_regs_used.length,
			total_stack,
		);
		if (total_stack > 0) {
			status.code += `add sp, sp, #${total_stack}\n`;
		}

		for (let i = loop_regs_used.length - 1; i >= 0; i--) {
			status.code += `ldr ${loop_regs_used[i]}, [sp], #16\n`;
		}

		for (let ci = callee_idx - 1; ci >= 0; ci--) {
			if (callee_saved[ci] === "x19" && needs_x19) continue;
			status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
		}
		if (needs_x19) {
			status.code += `ldr x19, [sp], #16\n`;
		}
		status.code += `ldp x29, x30, [sp], #16\n`;
		status.code += `ret\n`;

		status.scoped_declarations = old_scoped_declarations;
		status.function_param_regs = old_param_regs;
		status.function_param_vars = old_param_vars;
		status.function_ref_params = old_ref_params;
		status.function_return_label = old_return_label;
		status.force_heap_strings = old_force_heap;
		status.struct_return_buffer = undefined;
		status.function_return_type = undefined;
		status.return_buffer_stack_offset = undefined;
		status.stack_size = old_stack_size;
		status.stack_offsets = old_stack_offsets;
	}
}

function build_trait_functions(node: StructNode, status: BuildStatus) {
	for (const trait_name of node.traits) {
		const trait = status.traits.find((t) => t.name === trait_name);
		if (!trait) continue;

		for (const func of trait.functions) {
			if (func.name === "#init") continue;
			if (node.functions.find((f) => f.name === func.name)) continue;

			const func_label = `${node.name}_${func.name.replace(/#/g, "")}`;
			const trait_func_label = `${trait_name}_${func.name.replace(/#/g, "")}`;

			status.code += `.p2align 2\n`;
			status.code += `${func_label}:\n`;
			status.code += `b ${trait_func_label}\n`;
		}
	}

	for (const trait_name of node.traits) {
		const trait = status.traits.find((t) => t.name === trait_name);
		if (!trait) continue;

		for (const func of trait.functions) {
			if (!func.has_body) continue;

			const old_scoped_declarations = status.scoped_declarations;
			const old_stack_size = status.stack_size;
			const old_stack_offsets = status.stack_offsets;
			const old_param_regs = status.function_param_regs;
			const old_param_vars = status.function_param_vars;
			const old_return_label = status.function_return_label;

			status.scoped_declarations = [];
			status.stack_size = 0;
			status.stack_offsets = new Map();

			const trait_func_label = `${trait_name}_${func.name}`;
			const return_label = `.return_${trait_name}_${func.name}`;
			status.function_return_label = return_label;

			const stack_placeholder = `STACK_SIZE_${trait_func_label}`;

			status.code += `.p2align 2\n`;
			status.code += `${trait_func_label}:\n`;
			status.code += `stp x29, x30, [sp, #-16]!\n`;

			const is_self_param = func.params[0]?.is_self_param;
			const self_is_var = is_self_param && func.params[0]?.declaration === "var";
			const needs_x19 = is_self_param && !self_is_var;
			if (needs_x19) {
				status.code += `str x19, [sp, #-16]!\n`;
				status.code += `mov x19, x0\n`;
			}

			status.function_param_regs = new Map();
			status.function_param_vars = new Set();

			if (needs_x19) {
				status.function_param_regs.set("self", "x19");
			}

			status.code += `sub sp, sp, #${stack_placeholder}\n`;
			status.code += `mov x29, sp\n`;

			status.buffer_data_cache = undefined;
			build_block_node(func, status);

			status.code += `${return_label}:\n`;

			const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
			status.code = status.code.replace(
				`sub sp, sp, #${stack_placeholder}`,
				total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
			);
			if (total_stack > 0) {
				status.code += `add sp, sp, #${total_stack}\n`;
			}

			if (needs_x19) {
				status.code += `ldr x19, [sp], #16\n`;
			}
			status.code += `ldp x29, x30, [sp], #16\n`;
			status.code += `ret\n`;

			status.scoped_declarations = old_scoped_declarations;
			status.function_param_regs = old_param_regs;
			status.function_param_vars = old_param_vars;
			status.function_return_label = old_return_label;
			status.stack_size = old_stack_size;
			status.stack_offsets = old_stack_offsets;
		}
	}
}

/**
 * Emit read-only vtable data for a trait-conforming struct, mirroring the C
 * backend's `_Struct_traits` / `_get_trait_func`. For each trait the struct
 * conforms to we emit a function-pointer table (trait methods — the struct's
 * override if present, else the trait's default body — followed by get/set
 * pairs for each trait field), then a per-struct `_<Struct>_traits` array with
 * one slot per trait in global order (the table address for conformed traits,
 * 0 otherwise). The struct's init stores `&_<Struct>_traits` at offset 0, so a
 * trait-typed dispatch reads `[obj]` → vtable → `[vtable, #trait_index*8]` →
 * trait table → `[trait, #func_index*8]` → the concrete function.
 *
 * Trait field get/set accessors are also emitted here (the C backend emits them
 * in build_struct_functions). They handle scalar/string (single-word) fields;
 * multi-word struct trait fields are not yet supported through dispatch.
 */
function build_struct_traits(node: StructNode, status: BuildStatus) {
	if (node.traits.length === 0) return;

	for (const trait_name of node.traits) {
		const trait = status.traits.find((t) => t.name === trait_name);
		if (!trait) continue;

		status.vtable_data += `.p2align 3\n`;
		status.vtable_data += `_${node.name}_${trait_name}_funcs:\n`;
		for (const f of trait.functions) {
			if (f.name === "#init") continue;
			const label = node.functions.find((nf) => nf.name === f.name)
				? `${node.name}_${f.name.replace(/#/g, "")}`
				: `${trait_name}_${f.name.replace(/#/g, "")}`;
			status.vtable_data += `.quad ${label}\n`;
		}
		for (const field of trait.fields) {
			status.vtable_data += `.quad get_${node.name}_${field.name}\n`;
			status.vtable_data += `.quad set_${node.name}_${field.name}\n`;
		}
	}

	// 1-element destroy-funcs table, or NULL if the struct has no destroy
	// function. Slot [0] of _<Struct>_traits (below) holds the address of
	// this table (or 0); the synthesized `<Trait>_destroy` shim loads
	// [obj] → [vtable, #0] → [destroy_funcs, #0] → the concrete destroy fn,
	// so a ClassBuffer<Trait> reclaims heterogeneous boxed elements
	// polymorphically. The destroy fn exists when the struct has a user
	// #destroy, is a class (auto-destroy), or is a trait-conforming value
	// struct with owning fields (auto-destroy). For structs without any of
	// these, slot [0] is 0 and the shim's NULL check short-circuits.
	const has_destroy_fn =
		!!node.functions.find((f) => f.name === "#destroy") ||
		!!node.is_class ||
		(node.traits.length > 0 && has_struct_fields_with_destroy(node, status));
	if (has_destroy_fn) {
		status.vtable_data += `.p2align 3\n`;
		status.vtable_data += `_${node.name}_destroy_funcs:\n`;
		status.vtable_data += `.quad ${node.name}_destroy\n`;
	}
	const destroy_slot = has_destroy_fn ? `_${node.name}_destroy_funcs` : `0`;

	status.vtable_data += `.p2align 3\n`;
	status.vtable_data += `_${node.name}_traits:\n`;
	// Slot [0] = destroy funcs (or 0); slots [1..traits.length] = per-trait
	// funcs. The trait dispatch site in build_access_node.ts shifts
	// trait_index by +1 to skip the destroy slot.
	status.vtable_data += `.quad ${destroy_slot}\n`;
	for (const t of status.traits) {
		if (node.traits.includes(t.name)) {
			status.vtable_data += `.quad _${node.name}_${t.name}_funcs\n`;
		} else {
			status.vtable_data += `.quad 0\n`;
		}
	}

	for (const trait_name of node.traits) {
		const trait = status.traits.find((t) => t.name === trait_name);
		if (!trait) continue;
		for (const field of trait.fields) {
			const offset = get_field_offset(node.name, field.name, status);
			status.vtable_data += `.p2align 2\n`;
			status.vtable_data += `get_${node.name}_${field.name}:\n`;
			status.vtable_data += `ldr x0, [x0, #${offset}]\n`;
			status.vtable_data += `ret\n`;
			status.vtable_data += `.p2align 2\n`;
			status.vtable_data += `set_${node.name}_${field.name}:\n`;
			status.vtable_data += `str x1, [x0, #${offset}]\n`;
			status.vtable_data += `ret\n`;
		}
	}
}

function load_element(src_reg: string, offset: number, element_size: number): string {
	if (element_size === 1) {
		return `ldrb w9, [${src_reg}, #${offset}]\n`;
	} else if (element_size === 2) {
		return `ldrh w9, [${src_reg}, #${offset}]\n`;
	} else if (element_size === 4) {
		return `ldr w9, [${src_reg}, #${offset}]\n`;
	}
	return `ldr x9, [${src_reg}, #${offset}]\n`;
}

function store_element(dst_base: string, offset: number, element_size: number): string {
	let op: string;
	let reg: string;
	if (element_size === 1) {
		op = "strb";
		reg = "w9";
	} else if (element_size === 2) {
		op = "strh";
		reg = "w9";
	} else if (element_size === 4) {
		op = "str";
		reg = "w9";
	} else {
		op = "str";
		reg = "x9";
	}
	if (offset === 0) {
		return `${op} ${reg}, [${dst_base}]\n`;
	}
	return `${op} ${reg}, [${dst_base}, #${offset}]\n`;
}
