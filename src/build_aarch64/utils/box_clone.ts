import type BuildStatus from "../../build_c/BuildStatus.ts";
import {
	box_clone_fn_name,
	box_field_mono,
	box_pointee_strings_are_heap,
	box_pointee_type,
	enum_copy_is_deep,
} from "../../build_common/box_clone.ts";
import { struct_needs_destroy } from "../../build_common/destroy_analysis.ts";
import { owns_strings_uniformly } from "../../build_common/has_string_fields.ts";
import { is_load_deep_copy_container, resolve_struct_type } from "../../build_common/mono_name.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import type Type from "../../nodes/Type.ts";
import { emit_malloc, emit_strdup } from "./audit.ts";
import { emit_enum_payload_strdups_at } from "./auto_destroy.ts";
import { emit_asm } from "./code_buffer.ts";
import {
	get_field_offset,
	get_field_offset_of_fields,
	get_struct_size,
	layout_fields,
} from "./struct_layout.ts";

/**
 * Emit the `<Box_T>_box_clone` helper for a `Box<T>` mono — the aarch64 twin
 * of the C backend's ensure_box_clone (see build_c/utils/box_clone.ts for the
 * rationale). x0 = src wrapper (NULL-safe), returns the clone in x0: malloc +
 * byte copy + fresh copies of every pointee field the wrapper's destroy would
 * reclaim (plain strings, deep-copyable containers, nested boxes,
 * payload-copyable enums). Class/trait-referencing state stays SHARED — the
 * pre-existing bounded gap recorded in FOLLOWUP.md.
 *
 * The DEFINITION buffers into `status.box_clone_definitions` (flushed at file
 * scope by build.ts after the statement walk — the call sites are
 * mid-function-body: the specialized load_T emitters), deduped per TU via
 * `status.emitted_box_clones`. Returns the helper's symbol.
 */
export function ensure_box_clone_aarch64(box_mono: StructNode, status: BuildStatus): string {
	if (!status.emitted_box_clones) status.emitted_box_clones = new Set();
	if (status.emitted_box_clones.has(box_mono.name)) return box_clone_fn_name(box_mono.name);
	status.emitted_box_clones.add(box_mono.name);
	const fn = box_clone_fn_name(box_mono.name);
	const T_SIZE = get_struct_size(box_mono.name, status);
	// Emit the body through a scratch status so the emit_* helpers (audit-
	// conditional malloc/free/strdup, the enum payload strdups) append to the
	// buffered text instead of the mid-function code stream. The label
	// counter threads through so generated labels never collide.
	const scratch = { ...status } as BuildStatus;
	scratch.asm_code_state = undefined;
	scratch.code = "";
	// Nested clones buffer through THIS scratch's field during the walk (see
	// the recursive ensure call below) — start clean so a stale copy of the
	// real buffer (taken by the spread) can never be re-added.
	scratch.box_clone_definitions = undefined;
	scratch.label_counter = status.label_counter ?? 0;
	const null_label = `.Lbox_clone_null_${(scratch.label_counter = (scratch.label_counter ?? 0) + 1)}`;
	emit_asm(scratch, `.p2align 2\n`);
	emit_asm(scratch, `${fn}:\n`);
	if (status.emit_mode === "system" && status.platform !== "windows") {
		emit_asm(scratch, `.globl _${fn}\n`);
		emit_asm(scratch, `_${fn} = ${fn}\n`);
	}
	emit_asm(scratch, `cbz x0, ${null_label}\n`);
	emit_asm(scratch, `stp x29, x30, [sp, #-16]!\n`);
	emit_asm(scratch, `stp x20, x21, [sp, #-16]!\n`);
	emit_asm(scratch, `mov x20, x0\n`); // x20 = src
	emit_asm(scratch, `mov x0, #${T_SIZE}\n`);
	emit_malloc(scratch);
	emit_asm(scratch, `mov x21, x0\n`); // x21 = dst (callee-saved across calls)
	emit_asm(scratch, `mov x0, x21\n`);
	emit_asm(scratch, `mov x1, x20\n`);
	emit_asm(scratch, `mov x2, #${T_SIZE}\n`);
	emit_asm(scratch, `bl _memcpy\n`);
	const pointee_type = box_pointee_type(box_mono);
	if (pointee_type) {
		const value_offset = get_field_offset(box_mono.name, "__value", status);
		emit_pointee_owned_copies_asm(scratch, pointee_type, "x21", value_offset, new Set());
	}
	emit_asm(scratch, `mov x0, x21\n`);
	emit_asm(scratch, `ldp x20, x21, [sp], #16\n`);
	emit_asm(scratch, `ldp x29, x30, [sp], #16\n`);
	emit_asm(scratch, `ret\n`);
	emit_asm(scratch, `${null_label}:\n`);
	emit_asm(scratch, `ret\n`);
	status.label_counter = scratch.label_counter;
	// A nested clone's ensure wrote its own text into THIS scratch's buffer
	// field (its `status` argument was this scratch) — flush it ahead of the
	// body built here, then append both to the real buffer.
	status.box_clone_definitions =
		(status.box_clone_definitions ?? "") + (scratch.box_clone_definitions ?? "") + scratch.code;
	return fn;
}

/**
 * Give the wrapper clone at `[base + acc]` fresh copies of every field its
 * destroy would free (x21 must stay valid: every arm clobbers only
 * caller-saved registers). Recurses through nested value-struct fields; a
 * nested Box field clones through its own helper.
 */
function emit_pointee_owned_copies_asm(
	scratch: BuildStatus,
	type: Type,
	base: string,
	acc: number,
	visiting: Set<string>,
): void {
	if (!type.name || type.is_ref || type.is_view || type.is_array || type.is_nullable) return;
	// A `Box<string>` pointee: the wrapper's destroy frees `__value.ptr`
	// unconditionally (the ctor strdup'd it), so the clone owns its own bytes.
	if (type.name === "string") {
		emit_asm(scratch, `ldr x0, [${base}, #${acc}]\n`);
		const skip = `.Lbcs_${(scratch.label_counter = (scratch.label_counter ?? 0) + 1)}`;
		emit_asm(scratch, `cbz x0, ${skip}\n`);
		emit_strdup(scratch);
		emit_asm(scratch, `str x0, [${base}, #${acc}]\n`);
		emit_asm(scratch, `${skip}:\n`);
		return;
	}
	const field_enum = scratch.enums.find((e) => e.name === type.name && e.has_associated_data);
	if (field_enum) {
		if (enum_copy_is_deep(field_enum, scratch)) {
			emit_enum_payload_strdups_at(scratch, field_enum.name, base, acc);
		}
		return;
	}
	const pointee = resolve_struct_type(type, scratch);
	if (!pointee || pointee.is_class) return;
	if (visiting.has(pointee.name)) return;
	visiting.add(pointee.name);
	const strings_are_heap = box_pointee_strings_are_heap(pointee, scratch);
	for (const field of clone_fields(pointee, scratch)) {
		const offset =
			acc + get_field_offset_of_fields(clone_fields(pointee, scratch), field.name, scratch);
		if (field.type.is_ref || field.type.is_view || field.type.is_array || field.type.is_nullable)
			continue;
		const nested_box = box_field_mono(field.type, scratch);
		if (nested_box) {
			const nested_fn = ensure_box_clone_aarch64(nested_box, scratch);
			emit_asm(scratch, `ldr x0, [${base}, #${offset}]\n`);
			const skip = `.Lbcc_${(scratch.label_counter = (scratch.label_counter ?? 0) + 1)}`;
			emit_asm(scratch, `cbz x0, ${skip}\n`);
			emit_asm(scratch, `bl ${nested_fn}\n`);
			emit_asm(scratch, `str x0, [${base}, #${offset}]\n`);
			emit_asm(scratch, `${skip}:\n`);
			continue;
		}
		if (field.type.name === "string" && strings_are_heap) {
			emit_asm(scratch, `ldr x0, [${base}, #${offset}]\n`);
			const skip = `.Lbcs_${(scratch.label_counter = (scratch.label_counter ?? 0) + 1)}`;
			emit_asm(scratch, `cbz x0, ${skip}\n`);
			emit_strdup(scratch);
			emit_asm(scratch, `str x0, [${base}, #${offset}]\n`);
			emit_asm(scratch, `${skip}:\n`);
			continue;
		}
		// A container field (`List<T>`/`Buffer<T>` mono): its `copy` yields an
		// independent slab — the same predicate the load deep-copy uses
		// (self == sret is safe: the copy reads its input before the final
		// result write).
		const field_struct = resolve_struct_type(field.type, scratch);
		if (
			field_struct &&
			!field_struct.is_class &&
			is_load_deep_copy_container(field_struct.name) &&
			struct_needs_destroy(field_struct, scratch) &&
			field_struct.functions.find((f) => f.name === "copy")
		) {
			emit_asm(scratch, `add x8, ${base}, #${offset}\n`);
			emit_asm(scratch, `add x0, ${base}, #${offset}\n`);
			emit_asm(scratch, `bl ${field_struct.name}_copy\n`);
			continue;
		}
		const nested_enum = scratch.enums.find(
			(e) => e.name === field.type.name && e.has_associated_data,
		);
		if (nested_enum && enum_copy_is_deep(nested_enum, scratch)) {
			emit_enum_payload_strdups_at(scratch, nested_enum.name, base, offset);
			continue;
		}
		emit_pointee_owned_copies_asm(scratch, field.type, base, offset, visiting);
	}
}

/** The fields the pointee's destroy reclaims: an OWNING struct's
 *  trait-declared fields are uniformly heap (the ctor strdup'd their
 *  defaults) and join the walk, mirroring emit_field_destroys'
 *  layout_fields merge. */
function clone_fields(pointee: StructNode, status: BuildStatus): DeclarationNode[] {
	return pointee.is_class || owns_strings_uniformly(pointee)
		? layout_fields(pointee, status)
		: pointee.fields;
}
