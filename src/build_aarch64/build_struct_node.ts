import type BuildStatus from "../build_c/BuildStatus.ts";
import { struct_needs_auto_destroy } from "../build_common/destroy_analysis.ts";
import { moved_param_is_consumed } from "../build_common/scan_moved_param_consumed.ts";
import string_literal_length from "../build_common/string_literal_length.ts";
import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import RootNode from "../nodes/RootNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import { check_c_fallback } from "./build_raw_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free, emit_strdup } from "./utils/audit.ts";
import { emit_destroy_for_anchor_slot, emit_field_destroys } from "./utils/auto_destroy.ts";
import { find_enum_for_case } from "./utils/enum_case.ts";
import { is_nullable_struct_type } from "./utils/nullable_struct.ts";
import {
	emit_owning_buffer_destroy_aarch64,
	emit_owning_buffer_standalone_aarch64,
} from "./utils/owning_buffer_specialize.ts";
import scan_force_heap_strings from "./utils/scan_force_heap_strings.ts";
import {
	NUM_REG_ARGS,
	overflow_placeholder,
	patch_overflow_placeholders,
} from "./utils/stack_args.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";
import { emit_owning_array_string_specialize, emit_pair_store_to } from "./utils/string_pair.ts";
import {
	get_enum_case_index,
	get_enum_size,
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
 * Initialize a struct field whose default is an enum shorthand `.case`
 * (rewritten by the checker to `Enum_case` with is_enum_shorthand=true).
 * Returns true if handled. For a simple enum, emit the case index directly;
 * for an enum with associated data (a no-arg case), allocate a tag+payload
 * temp and struct-copy it into the field. Without this, the field-init
 * fallback would emit `adr xN, Enum_case`, which is an illegal text
 * relocation on macOS arm64.
 */
function init_enum_shorthand_field_default(
	node: StructNode,
	field: any,
	base_reg: string,
	status: BuildStatus,
): boolean {
	if (field.value?.node_type !== "value" || !field.value?.is_enum_shorthand) return false;
	const val = field.value.value;
	const found = find_enum_for_case(val, status);
	if (!found) return false;
	const enum_node = found.enum_node;
	const case_name = found.case_name;
	const case_index = get_enum_case_index(enum_node.name, case_name, status);
	if (case_index < 0) return false;
	const offset = get_field_offset(node.name, field.name, status);
	if (enum_node.has_associated_data) {
		// Build a tag+payload temp (tag at +0, zeroed payload) and copy it
		// word-by-word into the field slot.
		const enum_size = get_enum_size(enum_node.name, status);
		const temp_offset = (status.stack_size || 0) + 16;
		status.stack_size = (status.stack_size || 0) + 16 + enum_size;
		status.code += `mov x9, #${case_index}\n`;
		status.code += `str x9, [x29, #${temp_offset}]\n`;
		for (let off = 8; off < enum_size; off += 8) {
			status.code += `str xzr, [x29, #${temp_offset + off}]\n`;
		}
		const words = Math.ceil(enum_size / 8);
		for (let w = 0; w < words; w++) {
			status.code += `ldr x9, [x29, #${temp_offset + w * 8}]\n`;
			status.code += `str x9, [${base_reg}, #${offset + w * 8}]\n`;
		}
	} else {
		// Simple enum: case index is the whole value (8 bytes).
		status.code += `mov x1, #${case_index}\n`;
		emit_typed_store(status, "x1", base_reg, offset, 8);
	}
	return true;
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

/**
 * Resolve a module-level `const` declaration's literal value (e.g.
 * `const int INF = 2147483647` → `"2147483647"`). Returns undefined when the
 * name isn't a top-level const or its initializer isn't a simple literal.
 *
 * Field-default initialization runs inline in `*_init` (`ldr xN, =SYM`), and
 * `=SYM` loads the symbol's ADDRESS while creating an illegal text-relocation
 * on macOS arm64 — resolving the value at compile time sidesteps both issues.
 */
function resolve_global_const_value(name: string, status: BuildStatus): string | undefined {
	const root = status.root as RootNode;
	for (const stmt of root?.statements ?? []) {
		if (stmt.node_type !== "declare") continue;
		const decl = stmt as DeclarationNode;
		if (decl.declaration !== "const" || decl.name !== name) continue;
		if (decl.value?.node_type === "value") {
			const val = (decl.value as ValueNode).value;
			if (/^(\+|-)?\d+$/.test(val) || val === "true" || val === "false") {
				return val;
			}
		}
		return undefined;
	}
	return undefined;
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
		// Simple types (string, int, …) have no ctor/fields to build, but
		// their METHOD bodies need current_struct so `self.length` resolves
		// through the fat-pair prologue (len in x20) instead of a stale
		// generic load.
		status.current_struct = node;
		build_struct_functions(node, status);
		status.current_struct = undefined;
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
			if (emit_owning_buffer_destroy_aarch64(node, status)) {
				// Specialized per-element destroy emitted for owning Buffer.
			} else if (!check_c_fallback(destroy_func, node.name, status)) {
				build_destroy_function(node, destroy_func, status);
			}
		} else if (node.is_class) {
			build_auto_destroy_function(node, status);
		} else if (struct_needs_auto_destroy(node, status)) {
			// A value struct that owns heap data through its fields (e.g.
			// `struct Person { var string name }`) needs an auto-generated
			// <Struct>_destroy: Buffer<T> calls T_destroy per element when T
			// is an owning value struct (per-element destroy on replace /
			// scope exit), and trait-conforming owning value structs dispatch
			// destroy through the vtable when boxed into ClassBuffer<Trait>.
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

/**
 * Export a struct method for the precompiled System object. On macOS Mach-O,
 * bare L-prefixed names (`List_int_pop`) are treated as LOCAL and cannot be
 * `.globl`'d, so we export only the underscore form via an alias
 * (`_name = name`) — the user TU references `_name`. Only emitted for the
 * system TU; single-TU builds keep methods file-local (as before).
 */
function emit_method_export(label: string, status: BuildStatus) {
	if (status.emit_mode === "system" && status.platform !== "windows") {
		status.code += `.globl _${label}\n`;
		status.code += `_${label} = ${label}\n`;
	}
}

function build_destroy_function(node: StructNode, func: FunctionNode, status: BuildStatus) {
	const func_label = `${node.name}_destroy`;

	const old_scoped_declarations = status.scoped_declarations;

	const old_heap_strings = status.heap_strings;
	const old_heap_string_arrays = status.heap_string_arrays;
	status.heap_string_arrays = undefined;
	const old_heap_class_arrays = status.heap_class_arrays;
	status.heap_class_arrays = undefined;
	const old_heap_array_vars = status.heap_array_vars;
	status.heap_array_vars = undefined;
	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;

	status.scoped_declarations = [];
	status.heap_strings = new Set<string>();
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const return_label = `.return_${func_label}`;
	status.function_return_label = return_label;

	const stack_placeholder = `STACK_SIZE_${func_label}`;

	status.code += `.p2align 2\n`;
	status.code += `${func_label}:\n`;
	emit_method_export(func_label, status);
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
	status.heap_strings = old_heap_strings;
	status.heap_string_arrays = old_heap_string_arrays;
	status.heap_class_arrays = old_heap_class_arrays;
	status.heap_array_vars = old_heap_array_vars;
	status.function_param_regs = old_param_regs;
	status.function_param_vars = old_param_vars;
	status.function_return_label = old_return_label;
	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
}

function build_auto_destroy_function(node: StructNode, status: BuildStatus) {
	const func_label = `${node.name}_destroy`;

	const old_scoped_declarations = status.scoped_declarations;

	const old_heap_strings = status.heap_strings;
	const old_heap_string_arrays = status.heap_string_arrays;
	status.heap_string_arrays = undefined;
	const old_heap_class_arrays = status.heap_class_arrays;
	status.heap_class_arrays = undefined;
	const old_heap_array_vars = status.heap_array_vars;
	status.heap_array_vars = undefined;
	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;

	status.scoped_declarations = [];
	status.heap_strings = new Set<string>();
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const return_label = `.return_${func_label}`;
	status.function_return_label = return_label;

	const stack_placeholder = `STACK_SIZE_${func_label}`;

	status.code += `.p2align 2\n`;
	status.code += `${func_label}:\n`;
	emit_method_export(func_label, status);
	status.code += `stp x29, x30, [sp, #-16]!\n`;
	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_param_regs.set("self", "x19");

	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	// No user body — just destroy class-typed fields. free_strings for
	// classes: a class's plain string fields are always heap-owned (`_init`
	// strdup's defaults, assignments strdup non-heap RHS), so the destroy
	// frees them. Value structs keep free_strings=false (their locals may
	// hold rodata literals; only the strdup'ing Buffer store path owns).
	emit_field_destroys(status, node, "self", undefined, false, node.is_class);

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
	status.heap_strings = old_heap_strings;
	status.heap_string_arrays = old_heap_string_arrays;
	status.heap_class_arrays = old_heap_class_arrays;
	status.heap_array_vars = old_heap_array_vars;
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
	emit_method_export(func_name, status);
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
	// Fat-string fields consume TWO AAPCS slots (ptr, len pair) — track the
	// register-slot index separately from the field index.
	let ctor_slot = 1;
	for (let i = 0; i < required_fields.length; i++) {
		const field = required_fields[i];
		const offset = get_field_offset(node.name, field.name, status);
		// x19 is the destination (self pointer); field i arrives in slot i+1
		// (x1, x2, …). Slots past x7 arrive in the caller's outgoing stack
		// area; with one callee-saved push (x19) between `stp x29, x30` and
		// `sub sp, sp, #STACK_SIZE`, slot (8+k) lives at the per-arg
		// placeholder offset patched once the local frame size is known.
		const slot = ctor_slot;
		// A fat-string FIELD consumes two AAPCS slots (ptr, len) — but a
		// fixed-size string ARRAY field (`var string[2] args`) arrives as
		// ONE pointer to the caller's row data and is copied element-wise
		// by the array branch below. A `view T` field is likewise a
		// (ptr, len) pair: two slots, stored raw (never strdup'd).
		const field_is_view = !!field.type.is_view && !field.type.is_array;
		const field_is_fat_string =
			field.type.name === "string" &&
			!field.type.is_view &&
			!field.type.is_ref &&
			!field.type.is_array;
		if (field_is_view || field_is_fat_string) ctor_slot += 2;
		else ctor_slot += 1;
		let src_reg: string;
		if (slot < NUM_REG_ARGS) {
			src_reg = param_regs[slot - 1];
		} else {
			const k = slot - NUM_REG_ARGS;
			status.code += `ldr x10, [x29, #${overflow_placeholder(func_name, k)}]\n`;
			src_reg = "x10";
		}
		// A view FIELD stores both halves of the incoming pair verbatim —
		// it is a non-owning borrow, so no duplication ever happens.
		if (field_is_view) {
			const len_src = slot + 1 < NUM_REG_ARGS ? param_regs[slot] : undefined;
			if (len_src) {
				emit_pair_store_to(status, "x19", offset, src_reg, len_src);
			} else {
				// Pair straddles the register/overflow boundary.
				const k2 = slot + 1 - NUM_REG_ARGS;
				status.code += `str ${src_reg}, [x19, #${offset}]\n`;
				status.code += `ldr x9, [x29, #${overflow_placeholder(func_name, k2)}]\n`;
				status.code += `str x9, [x19, #${offset + 8}]\n`;
			}
			continue;
		}
		// A fat-string field stores both halves: ptr from its slot, len from
		// the next slot. A CLASS's plain string field is always heap-owned —
		// strdup the caller's (possibly rodata) ptr half so destroy can free
		// it unconditionally.
		if (field_is_fat_string) {
			const len_src = slot + 1 < NUM_REG_ARGS ? param_regs[slot] : undefined;
			if (node.is_class && !field.type.is_ref) {
				// Class string fields are always heap-owned: strdup the ptr
				// half. The strdup wrapper call clobbers every caller-saved
				// register, so BOTH halves must be spilled across it.
				status.code += `stp ${src_reg}, ${len_src ?? "xzr"}, [sp, #-16]!\n`;
				status.code += `mov x0, ${src_reg}\n`;
				emit_strdup(status);
				status.code += `ldp ${src_reg}, ${len_src ?? "xzr"}, [sp], #16\n`;
				status.code += `mov ${src_reg}, x0\n`;
			}
			if (len_src) {
				emit_pair_store_to(status, "x19", offset, src_reg, len_src);
			} else {
				// Pair straddles the register/overflow boundary.
				const k2 = slot + 1 - NUM_REG_ARGS;
				status.code += `str ${src_reg}, [x19, #${offset}]\n`;
				status.code += `ldr x9, [x29, #${overflow_placeholder(func_name, k2)}]\n`;
				status.code += `str x9, [x19, #${offset + 8}]\n`;
			}
			continue;
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
			// A nullable struct value field (`T? f`) is passed at the call
			// site as combined `[struct | flag]` storage. After copying the
			// struct value words above, also copy the companion `_has` flag
			// (the 8-byte word immediately after the struct value in the
			// source) into the field's has-offset in self.
			if (is_nullable_struct_type(field.type, status)) {
				const has_off = get_field_has_offset(node.name, field.name, status);
				status.code += `ldr x9, [${src_reg}, #${field_size}]\n`;
				status.code += `str x9, [x19, #${has_off}]\n`;
			}
		} else {
			const field_size = get_type_size(field.type, status);
			// A class's plain string field is always heap-owned: strdup the
			// caller's (possibly static/borrowed) argument so the field can
			// be freed unconditionally at destroy. Value structs keep the raw
			// store (their fields' ownership is handled by the Buffer store
			// path).
			if (
				node.is_class &&
				field.type.name === "string" &&
				!field.type.is_ref &&
				!field.type.is_view
			) {
				status.code += `str ${src_reg}, [sp, #-16]!\n`;
				status.code += `mov x0, ${src_reg}\n`;
				status.code += `bl _strdup\n`;
				status.code += `mov ${src_reg}, x0\n`;
				status.code += `ldr x0, [sp], #16\n`;
			}
			emit_typed_store(status, src_reg, "x19", offset, field_size);
		}
	}

	for (const field of node.fields) {
		if (field.value) {
			if (init_nullable_field_default(node, field, "x19", status)) continue;
			if (init_enum_shorthand_field_default(node, field, "x19", status)) continue;
			const offset = get_field_offset(node.name, field.name, status);
			const val = field.value.node_type === "value" ? (field.value as any).value : undefined;
			// A defaulted `view T` field: a string literal borrows its static
			// storage via the pair store below; anything else zeroes the pair
			// (a scalar has no meaningful slice identity). Never strdup'd —
			// views are non-owning.
			if (
				field.type.is_view &&
				!field.type.is_array &&
				!(typeof val === "string" && val.startsWith('"'))
			) {
				emit_pair_store_to(status, "x19", offset, "xzr", "xzr");
				continue;
			}
			if (field.value.node_type === "value") {
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
					// A class's default string literal must be heap-owned —
					// the field is freed unconditionally at destroy. (The
					// literal `bl _strdup` is rewritten to the audit wrapper
					// by build.ts's final sweep.)
					if (
						node.is_class &&
						field.type.name === "string" &&
						!field.type.is_ref &&
						!field.type.is_view
					) {
						status.code += `mov x0, x1\n`;
						status.code += `bl _strdup\n`;
						status.code += `mov x1, x0\n`;
					}
					// Fat-string default: carry the compile-time length half,
					// then skip the generic single-word store below.
					status.code += `mov x2, #${string_literal_length(val)}\n`;
					if (offset + 8 > 504) {
						emit_pair_store_to(status, "x19", offset, "x1", "x2");
					} else {
						emit_pair_store_to(status, "x19", offset, "x1", "x2");
					}
					continue;
				} else {
					// Non-literal default: a module-level const reference
					// (e.g. `var int hi = INF` with `const int INF = …`).
					// `ldr xN, =SYM` loads the symbol's ADDRESS and creates an
					// illegal text-relocation on macOS arm64; resolve the
					// const's value at compile time, falling back to
					// PC-relative adr + typed load of the stored value.
					const resolved = resolve_global_const_value(val, status);
					if (resolved !== undefined) {
						status.code += `ldr x1, =${resolved}\n`;
					} else {
						const vsize = get_type_size(field.type, status);
						status.code += `adr x1, ${val}\n`;
						if (vsize <= 1) {
							status.code += `ldrb w1, [x1]\n`;
						} else if (vsize <= 2) {
							status.code += `ldrh w1, [x1]\n`;
						} else if (vsize <= 4) {
							status.code += `ldr w1, [x1]\n`;
						} else {
							status.code += `ldr x1, [x1]\n`;
						}
					}
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

	const old_heap_strings = status.heap_strings;
	const old_heap_string_arrays = status.heap_string_arrays;
	status.heap_string_arrays = undefined;
	const old_heap_class_arrays = status.heap_class_arrays;
	status.heap_class_arrays = undefined;
	const old_heap_array_vars = status.heap_array_vars;
	status.heap_array_vars = undefined;
	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;

	status.scoped_declarations = [];
	status.heap_strings = new Set<string>();
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const return_label = `.return_${node.name}_init`;
	status.function_return_label = return_label;

	const stack_placeholder = `STACK_SIZE_${func_name}`;

	status.code += `.p2align 2\n`;
	status.code += `${func_name}:\n`;
	emit_method_export(func_name, status);
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
			if (init_enum_shorthand_field_default(node, field, "x19", status)) continue;
			const offset = get_field_offset(node.name, field.name, status);
			const val = field.value.node_type === "value" ? (field.value as any).value : undefined;
			// A defaulted `view T` field: a string literal borrows its static
			// storage via the pair store below; anything else zeroes the pair
			// (a scalar has no meaningful slice identity). Never strdup'd —
			// views are non-owning.
			if (
				field.type.is_view &&
				!field.type.is_array &&
				!(typeof val === "string" && val.startsWith('"'))
			) {
				emit_pair_store_to(status, "x19", offset, "xzr", "xzr");
				continue;
			}
			if (field.value.node_type === "value") {
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
					// A class's default string literal must be heap-owned —
					// the field is freed unconditionally at destroy. (The
					// literal `bl _strdup` is rewritten to the audit wrapper
					// by build.ts's final sweep.)
					if (
						node.is_class &&
						field.type.name === "string" &&
						!field.type.is_ref &&
						!field.type.is_view
					) {
						status.code += `mov x0, x1\n`;
						status.code += `bl _strdup\n`;
						status.code += `mov x1, x0\n`;
					}
					// Fat-string default: carry the compile-time length half,
					// then skip the generic single-word store below.
					status.code += `mov x2, #${string_literal_length(val)}\n`;
					if (offset + 8 > 504) {
						emit_pair_store_to(status, "x19", offset, "x1", "x2");
					} else {
						emit_pair_store_to(status, "x19", offset, "x1", "x2");
					}
					continue;
				} else {
					// Non-literal default: a module-level const reference
					// (e.g. `var int hi = INF` with `const int INF = …`).
					// `ldr xN, =SYM` loads the symbol's ADDRESS and creates an
					// illegal text-relocation on macOS arm64; resolve the
					// const's value at compile time, falling back to
					// PC-relative adr + typed load of the stored value.
					const resolved = resolve_global_const_value(val, status);
					if (resolved !== undefined) {
						status.code += `ldr x1, =${resolved}\n`;
					} else {
						const vsize = get_type_size(field.type, status);
						status.code += `adr x1, ${val}\n`;
						if (vsize <= 1) {
							status.code += `ldrb w1, [x1]\n`;
						} else if (vsize <= 2) {
							status.code += `ldrh w1, [x1]\n`;
						} else if (vsize <= 4) {
							status.code += `ldr w1, [x1]\n`;
						} else {
							status.code += `ldr x1, [x1]\n`;
						}
					}
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
	status.heap_strings = old_heap_strings;
	status.heap_string_arrays = old_heap_string_arrays;
	status.heap_class_arrays = old_heap_class_arrays;
	status.heap_array_vars = old_heap_array_vars;
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
		const old_heap_strings = status.heap_strings;
		const old_heap_string_arrays = status.heap_string_arrays;
		status.heap_string_arrays = undefined;
		const old_heap_class_arrays = status.heap_class_arrays;
		status.heap_class_arrays = undefined;
		const old_heap_array_vars = status.heap_array_vars;
		status.heap_array_vars = undefined;
		const old_stack_size = status.stack_size;
		const old_stack_offsets = status.stack_offsets;
		const old_param_regs = status.function_param_regs;
		const old_param_vars = status.function_param_vars;
		const old_return_label = status.function_return_label;
		const old_force_heap = status.force_heap_strings;
		const old_function_name = status.current_function_name;

		status.scoped_declarations = [];
		status.heap_strings = new Set<string>();
		status.stack_size = 0;
		status.stack_offsets = new Map();
		// Reset the transient heap-string flag so it doesn't leak from the
		// previous function's last statement (e.g. a move_T strdup in `pop`
		// setting it true) into this function's return classification.
		status.last_result_is_heap = false;

		const func_label = is_overloaded(node, func.name)
			? mangled_label(func, node.name)
			: `${node.name}_${func.name.replace(/#/g, "")}`;
		const return_label = `.return_${func_label}`;
		status.function_return_label = return_label;

		const stack_placeholder = `STACK_SIZE_${func_label}`;

		status.code += `.p2align 2\n`;
		status.code += `${func_label}:\n`;
		emit_method_export(func_label, status);
		status.code += `stp x29, x30, [sp, #-16]!\n`;

		const is_self_param = func.params[0]?.is_self_param;
		const self_is_var = is_self_param && func.params[0]?.declaration === "var";
		const self_is_ref = is_self_param && !!(func.params[0].is_ref || func.params[0].type?.is_ref);
		// A `string` struct's by-value self arrives as the (x0=ptr, x1=len)
		// pair. Raw bodies read the pointer from x19 (the long-standing
		// convention); the len half lives in x20 — `.length` on self is
		// `mov x0, x20`, and fat rewrites of String.nm's raw bodies read it
		// from there too.
		const self_is_string = is_self_param && node.name === "string" && !self_is_var && !self_is_ref;
		// `ref self` on a SIMPLE type (e.g. string.set) follows the by-ref
		// convention: x0 arrives holding &receiver, while raw #arch: aarch64
		// bodies expect x19 = the self VALUE (the same convention read-only
		// self uses, e.g. string.at's `ldrb w0, [x19, x1]`). Load through the
		// pointer so both agree. (For non-simple structs, ref self keeps the
		// historical by-address x19 = x0 — the value/struct convention.)
		const needs_x19 = is_self_param && (!self_is_var || (self_is_ref && node.is_simple_type));
		const x19_through_ref = needs_x19 && self_is_var;
		if (needs_x19) {
			if (self_is_string) {
				status.code += `stp x19, x20, [sp, #-16]!\n`;
				status.code += x19_through_ref ? `ldr x19, [x0]\n` : `mov x19, x0\n`;
				if (!x19_through_ref) status.code += `mov x20, x1\n`;
			} else {
				status.code += `str x19, [sp, #-16]!\n`;
				status.code += x19_through_ref ? `ldr x19, [x0]\n` : `mov x19, x0\n`;
			}
		}

		const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
		const callee_saved = ["x19", "x20", "x21", "x22"];
		let callee_idx = 0;
		if (needs_x19) {
			callee_idx = 1;
		}

		const old_ref_params = status.function_ref_params;
		const old_ref_class_slots = status.ref_class_slots;
		const old_view_params = status.function_view_params;

		status.function_param_regs = new Map();
		status.function_param_vars = new Set();
		status.function_ref_params = new Set();
		status.ref_class_slots = new Map();
		status.function_view_params = new Set();
		status.struct_return_buffer = undefined;

		// An ARRAY-typed return (`out Array<T>`) is a heap buffer POINTER in
		// x0 — never sret, even when the element type is a struct (the
		// element name would otherwise match below).
		const return_struct =
			!func.return_type?.is_array &&
			!!status.structs.find(
				(s) => s.name === func.return_type?.name && !s.is_simple_type && !s.is_class,
			);
		let return_buffer_stack_offset: number | undefined;
		// Record the function name so build_return_node can register the
		// function in heap_returning_functions and look up its return type
		// (e.g. to strdup a move_T result in List<string>.pop).
		// function_return_type is set only for struct (sret) returns below —
		// setting it unconditionally changes the string-ownership analysis
		// (literal-return strdup) for methods that were previously fine.
		status.current_function_name = func.name;
		if (return_struct) {
			status.function_return_type = func.return_type;
			status.struct_return_buffer = "x8";
		}

		// Register self→x19 only for the by-address convention (read-only
		// self). A `ref self` on a simple type must stay OUT of the param-reg
		// map: uses then route through the ref slot (function_ref_params), so
		// `self = ...` writes back through to the caller's storage instead of
		// silently reassigning the x19 copy. x19 still carries the loaded
		// value for raw #arch bodies to read.
		if (needs_x19 && !self_is_var) {
			status.function_param_regs.set("self", "x19");
		}

		// Track the AAPCS64 register slot index. self takes slot 0 (whether
		// moved to x19 or, for `var self`, treated as a regular struct param);
		// variadics take 2 slots (count + ptr); every other param takes 1.
		let slot_idx = 0;
		for (let i = 0; i < func.params.length; i++) {
			const param = func.params[i];
			if (param.is_self_param && !self_is_var) {
				// A fat-string BY-VALUE self is a (ptr, len) pair — two AAPCS
				// slots. (`ref self` on a simple type passes &slot — one.)
				slot_idx += self_is_string ? 2 : 1;
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
			// A fat `string` or `view T` param arrives as a (ptr, len)
			// register pair — two AAPCS64 slots, not a by-address struct
			// param.
			if (param.type.is_view || param.type.name === "string") {
				slot_idx += 2;
				continue;
			}
			// Enum-with-data params arrive as a pointer to the 16-byte
			// tag+payload blob (same convention as struct params) — mirrors
			// the is_enum_with_data handling in build_function_node. A class
			// param is a heap pointer the body reads as a value, so it stays
			// in the callee-saved register path (see build_function_node).
			const is_struct_type =
				!!status.structs.find((s) => s.name === param.type.name && !s.is_simple_type) ||
				!!status.enums.find((e) => e.name === param.type.name && e.has_associated_data);
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
				// Register class params in class_vars so value-access recognises
				// them as classes and does NOT dereference the pointer (the
				// pointer IS the value). Mirrors the C backend's prologue.
				if (!status.class_vars) status.class_vars = new Set();
				status.class_vars.add(param.name);
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
				second_slot_idx += self_is_string ? 2 : 1;
				continue;
			}
			if (param.is_variadic) {
				second_slot_idx += 2;
				continue;
			}
			// A `view T` param is a (ptr, len) pair: spill both halves into a
			// 16-byte local (two register slots — matching the call site's
			// pair passing), then skip the generic single-slot spill.
			if (param.type.is_view) {
				const offset = allocate_stack_space(status, 16, 16);
				status.stack_offsets!.set(param.name, offset);
				status.function_view_params!.add(param.name);
				// Each half comes from its own register slot, or from the
				// caller's outgoing stack area when its slot is past x7.
				for (const half of [0, 1] as const) {
					const p_slot = second_slot_idx + half;
					if (p_slot < NUM_REG_ARGS) {
						status.code += `str ${param_regs[p_slot]}, [x29, #${offset + half * 8}]\n`;
					} else {
						const k = p_slot - NUM_REG_ARGS;
						status.code += `ldr x9, [x29, #${overflow_placeholder(func_label, k)}]\n`;
						status.code += `str x9, [x29, #${offset + half * 8}]\n`;
					}
				}
				second_slot_idx += 2;
				continue;
			}
			// A fat `string` param is a (ptr, len) pair: spill both halves
			// into a 16-byte local (two register slots — matching the call
			// site's pair passing), then skip the generic single-slot spill.
			if (param.type.name === "string") {
				const offset = allocate_stack_space(status, 16, 16);
				status.stack_offsets!.set(param.name, offset);
				// Each half comes from its own register slot, or from the
				// caller's outgoing stack area when its slot is past x7.
				for (const half of [0, 1] as const) {
					const p_slot = second_slot_idx + half;
					if (p_slot < NUM_REG_ARGS) {
						status.code += `str ${param_regs[p_slot]}, [x29, #${offset + half * 8}]\n`;
					} else {
						const k = p_slot - NUM_REG_ARGS;
						status.code += `ldr x9, [x29, #${overflow_placeholder(func_label, k)}]\n`;
						status.code += `str x9, [x29, #${offset + half * 8}]\n`;
					}
				}
				second_slot_idx += 2;
				continue;
			}
			const is_struct_type =
				!!status.structs.find((s) => s.name === param.type.name && !s.is_simple_type) ||
				!!status.enums.find((e) => e.name === param.type.name && e.has_associated_data);
			if (!is_struct_type) {
				const size = aarch64_size(param.type.name);
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(param.name, offset);
				if (param.is_self_param) {
					// `var self` (= `ref self` here): self takes slot 0 (in
					// x0) — not a stack arg. For `ref self` on a simple type
					// the slot must hold the RAW incoming &receiver (x0); x19
					// carries the dereferenced value for raw bodies only.
					const save_reg = x19_through_ref ? "x0" : needs_x19 ? "x19" : param_regs[second_slot_idx];
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
			} else if (param.type.is_ref) {
				// A `ref` class param's callee-saved register (assigned in the
				// first pass) currently holds the ADDRESS of the caller's
				// pointer slot. Field access expects the register to hold the
				// instance, so dereference once — and save &slot separately (in
				// a dedicated slot) for the reassignment write-back path.
				// Mirrors build_function_node's top-level prologue.
				const is_class = !!status.structs.find((s) => s.name === param.type.name && s.is_class);
				if (is_class) {
					const reg = status.function_param_regs.get(param.name);
					if (reg) {
						const ref_slot = allocate_stack_space(status, 8, 8);
						status.code += `str ${reg}, [x29, #${ref_slot}]\n`;
						status.code += `ldr ${reg}, [${reg}]\n`;
						status.ref_class_slots!.set(param.name, ref_slot);
					}
				}
			}
			second_slot_idx++;
		}

		// Save mov'd class param values for cleanup at return — mirrors
		// build_function_node's top-level prologue (a method's `mov Box b` param
		// is owned by the callee and must be reclaimed at its return label).
		// A param with a callee-saved register needs a dedicated spill slot; one
		// that missed the callee-saved pool already lives in its own param slot.
		const moved_param_save_slots = new Map<
			string,
			{ offset: number; type_name: string; type_args?: Type[]; is_nullable?: boolean }
		>();
		for (const param of func.params) {
			if (!param.is_moved || param.is_self_param) continue;
			if (!status.structs.find((s) => s.name === param.type.name && s.is_class)) continue;
			const reg = status.function_param_regs.get(param.name);
			if (reg) {
				const save_offset = allocate_stack_space(status, 8);
				status.code += `str ${reg}, [x29, #${save_offset}]\n`;
				moved_param_save_slots.set(param.name, {
					offset: save_offset,
					type_name: param.type.name,
					type_args: param.type.type_args,
					is_nullable: param.type.is_nullable,
				});
			} else {
				const offset = status.stack_offsets!.get(param.name);
				if (offset !== undefined) {
					moved_param_save_slots.set(param.name, {
						offset,
						type_name: param.type.name,
						type_args: param.type.type_args,
						is_nullable: param.type.is_nullable,
					});
				}
			}
		}

		status.force_heap_strings = scan_force_heap_strings(func.statements, status.structs);
		status.buffer_data_cache = undefined;
		// Snapshot the moved set so the reclaim below can tell a param moved
		// out WITHIN this body from a same-named variable already moved in an
		// enclosing context.
		const moved_before = new Set(status.moved ?? []);
		// Specialize Buffer_<T> store_T / replace_T for owning value struct
		// elements (deep-copy string fields, per-element destroy on replace).
		// In the standalone context: x19 = self, x1 = i, x2 = val (the raw
		// block's register convention — prologue copies but doesn't clobber).
		// Array<string>'s raw T-generic `with`/`set` copy shared pointers;
		// string slots must own deep copies (the C side guards this with
		// T_NEEDS_STRDUP). Specialize before the raw body would emit.
		if (
			node.name === "Array_string" &&
			(func.name === "with" ||
				func.name === "set" ||
				func.name === "at" ||
				func.name === "first" ||
				func.name === "at_end") &&
			emit_owning_array_string_specialize(func.name, status)
		) {
			// specialized — skip the raw body
		} else if (!emit_owning_buffer_standalone_aarch64(node, func.name, status)) {
			build_block_node(func, status);
		}

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

		// Reclaim mov'd class params at the return label (every return jumps
		// here): #destroy + field destroys, then free — skipping params moved
		// out within the body, and params whose ownership escapes into an
		// outliving value (stored into a container, forwarded, returned —
		// the shared consumed-scan mirrors the C backend's registration gate).
		// Mirrors build_function_node's epilogue, including spilling a
		// non-void return value across the frees (they clobber x0) and the
		// equality guard for class returns (the returned instance may be the
		// param itself).
		if (moved_param_save_slots.size > 0) {
			const ret_is_class =
				!!func.return_type?.name &&
				!!status.structs.find((s) => s.name === func.return_type!.name && s.is_class);
			const need_save = !!func.return_type?.name;
			const keep_prefix = `.Lkeep_mparam_${func_label.replace(/[^\w]/g, "_")}`;
			let return_save: number | undefined;
			if (ret_is_class || need_save) {
				return_save = allocate_stack_space(status, 8);
				status.code += `str x0, [x29, #${return_save}]\n`;
			}
			for (const [name, info] of moved_param_save_slots) {
				if (status.moved?.has(name) && !moved_before.has(name)) continue;
				if (moved_param_is_consumed(func, name)) continue;
				if (ret_is_class) {
					status.code += `ldr x0, [x29, #${info.offset}]\n`;
					status.code += `ldr x1, [x29, #${return_save!}]\n`;
					status.code += `cmp x0, x1\n`;
					status.code += `beq ${keep_prefix}_${name}\n`;
				}
				emit_destroy_for_anchor_slot(
					status,
					info.offset,
					info.type_name,
					info.type_args,
					info.is_nullable,
				);
				status.code += `ldr x0, [x29, #${info.offset}]\n`;
				emit_free(status);
				if (ret_is_class) {
					status.code += `${keep_prefix}_${name}:\n`;
				}
			}
			if (ret_is_class || need_save) {
				status.code += `ldr x0, [x29, #${return_save!}]\n`;
			}
		}

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
			if (self_is_string) {
				status.code += `ldp x19, x20, [sp], #16\n`;
			} else {
				status.code += `ldr x19, [sp], #16\n`;
			}
		}
		status.code += `ldp x29, x30, [sp], #16\n`;
		status.code += `ret\n`;

		status.scoped_declarations = old_scoped_declarations;
		status.heap_strings = old_heap_strings;
		status.heap_string_arrays = old_heap_string_arrays;
		status.heap_class_arrays = old_heap_class_arrays;
		status.heap_array_vars = old_heap_array_vars;
		status.function_param_regs = old_param_regs;
		status.function_param_vars = old_param_vars;
		status.function_ref_params = old_ref_params;
		status.ref_class_slots = old_ref_class_slots;
		status.function_view_params = old_view_params;
		status.function_return_label = old_return_label;
		status.force_heap_strings = old_force_heap;
		status.struct_return_buffer = undefined;
		status.function_return_type = undefined;
		status.current_function_name = old_function_name;
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
			emit_method_export(func_label, status);
			status.code += `b ${trait_func_label}\n`;
		}
	}

	for (const trait_name of node.traits) {
		const trait = status.traits.find((t) => t.name === trait_name);
		if (!trait) continue;

		for (const func of trait.functions) {
			if (!func.has_body) continue;
			// A generic trait's default bodies reference its type params (e.g.
			// `T`), unresolved at the trait level. They are cloned + substituted
			// per conformer into struct methods (synthesize_generic_trait_defaults),
			// so skip emitting the broken trait-level body here. Non-generic
			// traits keep the shared default-body emission.
			if (trait.type_params.length > 0) continue;

			const trait_func_label = `${trait_name}_${func.name}`;
			// The trait-level default body is shared across every conforming
			// struct; emit it once (the first conformer), not once per struct.
			if (!status.emitted_trait_funcs) status.emitted_trait_funcs = new Set();
			if (status.emitted_trait_funcs.has(trait_func_label)) continue;
			status.emitted_trait_funcs.add(trait_func_label);

			const old_scoped_declarations = status.scoped_declarations;
			const old_heap_strings = status.heap_strings;
			const old_heap_string_arrays = status.heap_string_arrays;
			status.heap_string_arrays = undefined;
			const old_heap_class_arrays = status.heap_class_arrays;
			status.heap_class_arrays = undefined;
			const old_heap_array_vars = status.heap_array_vars;
			status.heap_array_vars = undefined;
			const old_stack_size = status.stack_size;
			const old_stack_offsets = status.stack_offsets;
			const old_param_regs = status.function_param_regs;
			const old_param_vars = status.function_param_vars;
			const old_return_label = status.function_return_label;

			status.scoped_declarations = [];
			status.heap_strings = new Set<string>();
			status.stack_size = 0;
			status.stack_offsets = new Map();

			const return_label = `.return_${trait_name}_${func.name}`;
			status.function_return_label = return_label;

			const stack_placeholder = `STACK_SIZE_${trait_func_label}`;

			status.code += `.p2align 2\n`;
			status.code += `${trait_func_label}:\n`;
			emit_method_export(trait_func_label, status);
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
			status.heap_strings = old_heap_strings;
			status.heap_string_arrays = old_heap_string_arrays;
			status.heap_class_arrays = old_heap_class_arrays;
			status.heap_array_vars = old_heap_array_vars;
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
 * on aarch64 trait field access reads through the concrete storage directly
 * (build_access_field), so multi-word struct trait fields work via that path.
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
		(node.traits.length > 0 && struct_needs_auto_destroy(node, status));
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
