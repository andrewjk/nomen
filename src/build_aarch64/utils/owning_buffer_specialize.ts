import type BuildStatus from "../../build_c/BuildStatus.ts";
import StructNode from "../../nodes/StructNode.ts";
import aarch64_size from "./aarch64_size.ts";
import { emit_free, emit_strdup } from "./audit.ts";
import { get_struct_size, get_type_size } from "./struct_layout.ts";

/**
 * Detect whether a monomorphized struct is a `Buffer_<T>` whose element type
 * `T` is a value struct that owns heap data (string fields). Mirrors the C
 * backend's owning_buffer_element — see that file for the full rationale.
 * `string` elements use a separate owning path (see below).
 */
export function owning_buffer_element_aarch64(
	node: StructNode,
	status: BuildStatus,
): StructNode | undefined {
	if (!node.name.startsWith("Buffer_")) return undefined;
	const elem_name = node.name.substring("Buffer_".length);
	const elem = status.structs.find(
		(s) => s.name === elem_name && !s.is_simple_type && !s.is_generic,
	);
	if (!elem || elem.is_class) return undefined;
	// Only specialize if the element has string fields (the owning case that
	// needs deep-copy + per-element destroy).
	if (!has_string_fields(elem, status)) return undefined;
	return elem;
}

/**
 * A `Buffer<string>` owns an independent heap copy of each slot (strdup on
 * store_T, free+strdup on replace_T, per-slot free on #destroy). See the C
 * backend's owning_buffer_is_string_elem for the rationale.
 */
export function owning_buffer_is_string_elem_aarch64(node: StructNode): boolean {
	return node.name === "Buffer_string";
}

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
 * Collect the (name, offset) pairs for every string field in the element
 * struct, including those nested inside owning sub-structs. Used by the
 * specialized Buffer methods to strdup/free per field.
 */
function collect_string_fields(
	elem: StructNode,
	status: BuildStatus,
	base_offset = 0,
): { offset: number }[] {
	const result: { offset: number }[] = [];
	let offset = 8; // VT_SIZE prefix
	for (const field of elem.fields) {
		if (field.type.is_ref) {
			offset += get_type_size(field.type, status);
			continue;
		}
		if (field.type.name === "string" && !field.type.is_array) {
			result.push({ offset: base_offset + offset });
			offset += aarch64_size("string");
		} else {
			const field_struct = status.structs.find(
				(s) => s.name === field.type.name && !s.is_simple_type && !s.is_generic,
			);
			if (field_struct && !field_struct.is_class && has_string_fields(field_struct, status)) {
				result.push(...collect_string_fields(field_struct, status, base_offset + offset));
			}
			offset += get_type_size(field.type, status);
		}
	}
	return result;
}

/**
 * Emit `slot.field = strdup(src.field)` guarded against a NULL source field
 * (e.g. JsonTree's "no text" sentinel): a NULL field is copied as NULL —
 * strdup(NULL) would crash. `src`/`dst` are the register names holding the
 * source struct address and the destination slot address.
 */
function emit_strdup_field(
	status: BuildStatus,
	src: string,
	dst: string,
	foff: number,
	label_id: number,
) {
	status.code += `ldr x0, [${src}, #${foff}]\n`;
	status.code += `cbz x0, .Lskip_strdup_${label_id}\n`;
	emit_strdup(status);
	status.code += `str x0, [${dst}, #${foff}]\n`;
	status.code += `.Lskip_strdup_${label_id}:\n`;
}

/**
 * Emit a specialized inline expansion for a Buffer method whose element type
 * is an owning value struct. Called from build_inline_method BEFORE the raw
 * block is emitted. Returns true if the body was emitted.
 *
 * In the inline context, the parameters are in the AAPCS64 registers:
 *   x0 = self (Buffer struct pointer)
 *   x1 = i (index)
 *   x2 = val (address of the struct value, since T_SIZE > 8)
 */
export function emit_owning_buffer_inline_aarch64(
	struct_node: StructNode,
	func_name: string,
	status: BuildStatus,
): boolean {
	const elem = owning_buffer_element_aarch64(struct_node, status);
	if (elem) {
		if (func_name === "store_T") {
			emit_owning_store_T(elem, status);
			return true;
		}
		if (func_name === "replace_T") {
			emit_owning_replace_T(elem, status);
			return true;
		}
		return false;
	}
	if (owning_buffer_is_string_elem_aarch64(struct_node)) {
		if (func_name === "store_T") {
			emit_string_store_T(status, "x0");
			return true;
		}
		if (func_name === "replace_T") {
			emit_string_replace_T(status, "x0");
			return true;
		}
	}
	return false;
}

/**
 * Emit a specialized body for a STANDALONE (non-inline) Buffer method for
 * owning value struct elements. In the standalone context, x19 = self
 * (set up by the function prologue), and x1/x2 still hold the original arg
 * values (the prologue copies them to safe locations but does not clobber
 * the registers). Returns true if the body was emitted.
 */
export function emit_owning_buffer_standalone_aarch64(
	node: StructNode,
	func_name: string,
	status: BuildStatus,
): boolean {
	const elem = owning_buffer_element_aarch64(node, status);
	if (elem) {
		if (func_name !== "store_T" && func_name !== "replace_T") return false;
		emit_owning_standalone_struct(elem, func_name, status);
		return true;
	}
	if (owning_buffer_is_string_elem_aarch64(node)) {
		if (func_name === "store_T") {
			emit_string_store_T(status, "x19");
			return true;
		}
		if (func_name === "replace_T") {
			emit_string_replace_T(status, "x19");
			return true;
		}
	}
	return false;
}

function emit_owning_standalone_struct(elem: StructNode, func_name: string, status: BuildStatus) {
	const T_SIZE = get_struct_size(elem.name, status);
	const string_fields = collect_string_fields(elem, status);

	// x19 = self, x1 = i, x2 = val (struct address)
	status.code += `stp x20, x21, [sp, #-16]!\n`;
	status.code += `str x22, [sp, #-16]!\n`;
	status.code += `ldr x20, [x19, #8]\n`; // data base
	status.code += `mov x22, #${T_SIZE}\n`; // x22 = T_SIZE (callee-saved, survives calls)
	status.code += `madd x4, x1, x22, xzr\n`;
	status.code += `add x20, x20, x4\n`; // x20 = &slot[i]
	status.code += `mov x21, x2\n`; // x21 = val

	// replace_T destroys the OLD slot value (its documented overwrite
	// semantic). store_T does NOT — the round-trip guard below keeps the
	// slot's own copy instead of orphaning it.
	if (func_name === "replace_T") {
		status.code += `mov x0, x20\n`;
		status.code += `bl ${elem.name}_destroy\n`;
	}

	// store_T: save each string field's OLD slot pointer (before memcpy) so
	// the strdup can detect a load-modify-store round-trip (src aliases the
	// slot's own copy) and keep it instead of orphaning it.
	if (func_name === "store_T" && string_fields.length) {
		const tmp = Math.ceil((string_fields.length * 8) / 16) * 16;
		status.code += `sub sp, sp, #${tmp}\n`;
		string_fields.forEach((f, i) => {
			status.code += `ldr x9, [x20, #${f.offset}]\n`;
			status.code += `str x9, [sp, #${i * 8}]\n`;
		});
	}

	// memcpy(slot, val, T_SIZE) — x22 holds T_SIZE (preserved across calls)
	status.code += `mov x0, x20\n`;
	status.code += `mov x1, x21\n`;
	status.code += `mov x2, x22\n`;
	status.code += `bl _memcpy\n`;

	if (func_name === "store_T") {
		// strdup each string field, skipping NULL source fields and
		// round-trips (source pointer identical to the slot's pre-copy pointer).
		for (const [i, { offset: foff }] of string_fields.entries()) {
			const lbl = `.Lskip_st_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
			status.code += `ldr x1, [x21, #${foff}]\n`;
			status.code += `cbz x1, ${lbl}\n`;
			status.code += `ldr x2, [sp, #${i * 8}]\n`;
			status.code += `cmp x1, x2\n`;
			status.code += `b.eq ${lbl}\n`;
			status.code += `mov x0, x1\n`;
			emit_strdup(status);
			status.code += `str x0, [x20, #${foff}]\n`;
			status.code += `${lbl}:\n`;
		}
		if (string_fields.length) {
			const tmp = Math.ceil((string_fields.length * 8) / 16) * 16;
			status.code += `add sp, sp, #${tmp}\n`;
		}
	} else {
		// replace_T: the old value was destroyed, so every non-NULL source
		// field needs a fresh strdup.
		for (const { offset: foff } of string_fields) {
			emit_strdup_field(
				status,
				"x21",
				"x20",
				foff,
				(status.label_counter = (status.label_counter ?? 0) + 1),
			);
		}
	}

	status.code += `ldr x22, [sp], #16\n`;
	status.code += `ldp x20, x21, [sp], #16\n`;
	return true;
}

/**
 * Specialized `Buffer<string>` store_T. `self_reg` is the register holding
 * the Buffer pointer ("x0" inline, "x19" standalone); x1 = i, x2 = val (char*).
 * strdup the incoming pointer into the slot so the slot owns an independent
 * heap copy, with a round-trip guard (val == old slot → keep). x20/x21 are
 * callee-saved (survive the strdup call).
 */
function emit_string_store_T(status: BuildStatus, self_reg: string) {
	const lbl = (s: string) =>
		`.Lstr_st_${s}_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
	const skip = lbl("skip");
	const done = lbl("done");
	status.code += `stp x20, x21, [sp, #-16]!\n`;
	status.code += `ldr x20, [${self_reg}, #8]\n`; // data base
	status.code += `add x20, x20, x1, lsl #3\n`; // &slot[i] (i * 8)
	status.code += `mov x21, x2\n`; // val (callee-saved)
	status.code += `ldr x0, [x20]\n`; // old slot value
	status.code += `cmp x21, x0\n`;
	status.code += `b.eq ${skip}\n`; // val == old → keep
	status.code += `cbz x21, ${skip}\n`; // val == NULL → store NULL (fall through writes x21=0)
	status.code += `mov x0, x21\n`;
	emit_strdup(status);
	status.code += `str x0, [x20]\n`;
	status.code += `b ${done}\n`;
	status.code += `${skip}:\n`;
	status.code += `str x21, [x20]\n`; // store val (NULL or round-trip alias)
	status.code += `${done}:\n`;
	status.code += `ldp x20, x21, [sp], #16\n`;
}

/**
 * Specialized `Buffer<string>` replace_T. Free the old slot's heap copy, then
 * strdup the new value (round-trip guard: val == old → keep, no free).
 */
function emit_string_replace_T(status: BuildStatus, self_reg: string) {
	const lbl = (s: string) =>
		`.Lstr_rp_${s}_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
	const skip = lbl("skip");
	const done = lbl("done");
	status.code += `stp x20, x21, [sp, #-16]!\n`;
	status.code += `ldr x20, [${self_reg}, #8]\n`; // data base
	status.code += `add x20, x20, x1, lsl #3\n`; // &slot[i]
	status.code += `mov x21, x2\n`; // val (callee-saved)
	status.code += `ldr x0, [x20]\n`; // old slot value
	status.code += `cmp x21, x0\n`;
	status.code += `b.eq ${done}\n`; // val == old → keep (no free, no strdup)
	emit_free(status); // free(old) — old in x0
	status.code += `cbz x21, ${skip}\n`; // val == NULL → store NULL
	status.code += `mov x0, x21\n`;
	emit_strdup(status);
	status.code += `str x0, [x20]\n`;
	status.code += `b ${done}\n`;
	status.code += `${skip}:\n`;
	status.code += `str xzr, [x20]\n`;
	status.code += `${done}:\n`;
	status.code += `ldp x20, x21, [sp], #16\n`;
}

function emit_owning_store_T(elem: StructNode, status: BuildStatus) {
	const T_SIZE = get_struct_size(elem.name, status);
	const string_fields = collect_string_fields(elem, status);

	// x0 = self, x1 = i, x2 = val (address)
	// Save callee-saved registers
	status.code += `stp x20, x21, [sp, #-16]!\n`;
	status.code += `str x22, [sp, #-16]!\n`;
	// Compute slot address: data + i * T_SIZE
	status.code += `ldr x20, [x0, #8]\n`; // x20 = data base
	status.code += `mov x22, #${T_SIZE}\n`; // x22 = T_SIZE (callee-saved)
	status.code += `madd x4, x1, x22, xzr\n`; // byte offset
	status.code += `add x20, x20, x4\n`; // x20 = &slot[i]
	status.code += `mov x21, x2\n`; // x21 = val (save across calls)
	// Save each string field's OLD slot pointer (before memcpy) so the
	// strdup can detect a load-modify-store round-trip (src aliases the slot's
	// own copy) and keep it instead of orphaning it. The temp area is padded to
	// 16 bytes so sp stays AAPCS-aligned across the `bl _memcpy`.
	if (string_fields.length) {
		const tmp = Math.ceil((string_fields.length * 8) / 16) * 16;
		status.code += `sub sp, sp, #${tmp}\n`;
		string_fields.forEach((f, i) => {
			status.code += `ldr x9, [x20, #${f.offset}]\n`;
			status.code += `str x9, [sp, #${i * 8}]\n`;
		});
	}
	// memcpy(slot, val, T_SIZE)
	status.code += `mov x0, x20\n`; // dest
	status.code += `mov x1, x21\n`; // src
	status.code += `mov x2, x22\n`; // size
	status.code += `bl _memcpy\n`;
	// strdup each string field, skipping NULL source fields and round-trips
	// (source pointer identical to the slot's pre-copy pointer).
	for (const [i, { offset: foff }] of string_fields.entries()) {
		const lbl = `.Lskip_st_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
		status.code += `ldr x1, [x21, #${foff}]\n`; // src field
		status.code += `cbz x1, ${lbl}\n`;
		status.code += `ldr x2, [sp, #${i * 8}]\n`; // old slot field
		status.code += `cmp x1, x2\n`;
		status.code += `b.eq ${lbl}\n`;
		status.code += `mov x0, x1\n`;
		emit_strdup(status);
		status.code += `str x0, [x20, #${foff}]\n`;
		status.code += `${lbl}:\n`;
	}
	if (string_fields.length) {
		const tmp = Math.ceil((string_fields.length * 8) / 16) * 16;
		status.code += `add sp, sp, #${tmp}\n`;
	}
	// Restore
	status.code += `ldr x22, [sp], #16\n`;
	status.code += `ldp x20, x21, [sp], #16\n`;
}

function emit_owning_replace_T(elem: StructNode, status: BuildStatus) {
	const T_SIZE = get_struct_size(elem.name, status);
	const string_fields = collect_string_fields(elem, status);

	// x0 = self, x1 = i, x2 = val (address)
	status.code += `stp x20, x21, [sp, #-16]!\n`;
	status.code += `str x22, [sp, #-16]!\n`;
	// Compute slot address
	status.code += `ldr x20, [x0, #8]\n`; // data base
	status.code += `mov x22, #${T_SIZE}\n`; // x22 = T_SIZE (callee-saved)
	status.code += `madd x4, x1, x22, xzr\n`;
	status.code += `add x20, x20, x4\n`; // x20 = &slot[i]
	status.code += `mov x21, x2\n`; // x21 = val
	// Destroy old slot value
	status.code += `mov x0, x20\n`;
	status.code += `bl ${elem.name}_destroy\n`;
	// memcpy(slot, val, T_SIZE) — x22 preserved across destroy call
	status.code += `mov x0, x20\n`;
	status.code += `mov x1, x21\n`;
	status.code += `mov x2, x22\n`;
	status.code += `bl _memcpy\n`;
	// strdup each string field (NULL source fields stay NULL — no strdup)
	for (const { offset: foff } of string_fields) {
		emit_strdup_field(
			status,
			"x21",
			"x20",
			foff,
			(status.label_counter = (status.label_counter ?? 0) + 1),
		);
	}
	// Restore
	status.code += `ldr x22, [sp], #16\n`;
	status.code += `ldp x20, x21, [sp], #16\n`;
}

/**
 * Emit a specialized #destroy for a Buffer whose element type is an owning
 * value struct. Per-element T_destroy, then free the slab. Called from
 * build_struct_node instead of build_destroy_function when the element owns.
 * Returns true if the destroy was emitted.
 */
export function emit_owning_buffer_destroy_aarch64(node: StructNode, status: BuildStatus): boolean {
	const elem = owning_buffer_element_aarch64(node, status);
	const is_string = !elem && owning_buffer_is_string_elem_aarch64(node);
	if (!elem && !is_string) return false;

	// string slots are 8-byte char*; struct slots are T_SIZE bytes.
	const T_SIZE = elem ? get_struct_size(elem.name, status) : 8;
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
	status.code += `mov x19, x0\n`; // x19 = self
	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_param_regs.set("self", "x19");

	// if (self->data == 0) goto end
	status.code += `ldr x0, [x19, #8]\n`;
	status.code += `cbz x0, .Lownbuf_destroy_end_${func_label}\n`;
	// Save callee-saved
	status.code += `stp x20, x21, [sp, #-16]!\n`;
	status.code += `str x22, [sp, #-16]!\n`;
	status.code += `mov x20, x0\n`; // x20 = data base
	status.code += `ldr x21, [x19, #16]\n`; // x21 = cap
	status.code += `mov x22, #0\n`; // x22 = i = 0
	status.code += `.Lownbuf_destroy_loop_${func_label}:\n`;
	status.code += `cmp x22, x21\n`;
	status.code += `b.ge .Lownbuf_destroy_done_${func_label}\n`;
	// &slot[i] = x20 + i * T_SIZE
	status.code += `mov x3, #${T_SIZE}\n`;
	status.code += `madd x0, x22, x3, x20\n`;
	if (is_string) {
		// free(slot[i]) — a NULL slot (unused/moved) is a no-op free.
		status.code += `ldr x0, [x0]\n`;
		emit_free(status);
	} else {
		status.code += `bl ${elem!.name}_destroy\n`;
	}
	status.code += `add x22, x22, #1\n`;
	status.code += `b .Lownbuf_destroy_loop_${func_label}\n`;
	status.code += `.Lownbuf_destroy_done_${func_label}:\n`;
	status.code += `mov x0, x20\n`;
	emit_free(status);
	status.code += `ldr x22, [sp], #16\n`;
	status.code += `ldp x20, x21, [sp], #16\n`;
	status.code += `.Lownbuf_destroy_end_${func_label}:\n`;
	status.code += `str xzr, [x19, #8]\n`;
	status.code += `str xzr, [x19, #16]\n`;

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
	return true;
}
