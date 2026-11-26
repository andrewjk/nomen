import type BuildStatus from "../../build_c/BuildStatus.ts";
import { element_copy_struct } from "../../build_common/element_copy.ts";
import Type from "../../nodes/Type.ts";
import { emit_malloc } from "./audit.ts";
import { emit_asm } from "./code_buffer.ts";
import { get_struct_size, get_type_size } from "./struct_layout.ts";

/**
 * Deep-copy a NESTED heap array (`xs.copy()` with `deep_array_copy`): x0 =
 * the source BASE pointer (`[x0]` = count, slots from `+8`); returns x0 =
 * a fresh base pointer. Row slots are base pointers copied recursively; the
 * innermost slots are byte-copied, then strings get their own bytes and a
 * struct element is rebuilt through its own `copy()` (x0 = &src, x8 =
 * &dst) — the same contract as the library `Array.copy`. x19-x22 are saved
 * and restored per level.
 */
export function emit_deep_array_copy(status: BuildStatus, type: Type): void {
	const id = (status.label_counter = (status.label_counter ?? 0) + 1);
	const loop = `.Ldac_loop_${id}`;
	const next = `.Ldac_next_${id}`;
	const done = `.Ldac_done_${id}`;
	const row = type.elem as Type | undefined;
	const copy_struct = row ? undefined : element_copy_struct(type.name, status.structs);
	const is_string = !row && type.name === "string";
	const slot = row
		? 8
		: copy_struct
			? get_struct_size(copy_struct.name, status)
			: get_type_size(new Type(type.name), status);
	emit_asm(status, `stp x19, x20, [sp, #-16]!\n`);
	emit_asm(status, `stp x21, x22, [sp, #-16]!\n`);
	emit_asm(status, `mov x19, x0\n`);
	emit_asm(status, `ldr x20, [x19]\n`);
	emit_asm(status, `mov x1, #${slot}\n`);
	emit_asm(status, `mul x0, x20, x1\n`);
	emit_asm(status, `add x0, x0, #8\n`);
	emit_malloc(status);
	emit_asm(status, `mov x21, x0\n`);
	emit_asm(status, `str x20, [x21]\n`);
	// Byte-copy every slot first; the loop below replaces the owning ones.
	emit_asm(status, `add x0, x21, #8\n`);
	emit_asm(status, `add x1, x19, #8\n`);
	emit_asm(status, `mov x2, #${slot}\n`);
	emit_asm(status, `mul x2, x20, x2\n`);
	emit_asm(status, `bl _memcpy\n`);
	if (row || is_string || copy_struct) {
		emit_asm(status, `mov x22, #0\n`);
		emit_asm(status, `${loop}:\n`);
		emit_asm(status, `cmp x22, x20\n`);
		emit_asm(status, `b.ge ${done}\n`);
		// x9 = slot offset (recomputed after every call)
		const slot_offset = () => {
			emit_asm(status, `mov x9, #${slot}\n`);
			emit_asm(status, `mul x9, x22, x9\n`);
			emit_asm(status, `add x9, x9, #8\n`);
		};
		slot_offset();
		if (row) {
			emit_asm(status, `ldr x0, [x19, x9]\n`);
			emit_deep_array_copy(status, row);
			emit_asm(status, `mov x9, #8\n`);
			emit_asm(status, `mul x9, x22, x9\n`);
			emit_asm(status, `add x9, x9, #8\n`);
			emit_asm(status, `str x0, [x21, x9]\n`);
		} else if (is_string) {
			// Fresh bytes for the slot (length-based, NUL-terminated).
			emit_asm(status, `add x10, x19, x9\n`);
			emit_asm(status, `ldr x0, [x10]\n`);
			emit_asm(status, `cbz x0, ${next}\n`);
			emit_asm(status, `ldr x0, [x10, #8]\n`);
			emit_asm(status, `add x0, x0, #1\n`);
			emit_malloc(status);
			slot_offset();
			emit_asm(status, `add x10, x19, x9\n`);
			emit_asm(status, `str x0, [x21, x9]\n`);
			emit_asm(status, `ldr x1, [x10]\n`);
			emit_asm(status, `ldr x2, [x10, #8]\n`);
			emit_asm(status, `bl _memcpy\n`);
			slot_offset();
			emit_asm(status, `add x10, x19, x9\n`);
			emit_asm(status, `ldr x2, [x10, #8]\n`);
			emit_asm(status, `ldr x0, [x21, x9]\n`);
			emit_asm(status, `strb wzr, [x0, x2]\n`);
		} else if (copy_struct) {
			emit_asm(status, `add x0, x19, x9\n`);
			emit_asm(status, `add x8, x21, x9\n`);
			emit_asm(status, `bl ${copy_struct.name}_copy\n`);
		}
		emit_asm(status, `${next}:\n`);
		emit_asm(status, `add x22, x22, #1\n`);
		emit_asm(status, `b ${loop}\n`);
		emit_asm(status, `${done}:\n`);
	}
	emit_asm(status, `mov x0, x21\n`);
	emit_asm(status, `ldp x21, x22, [sp], #16\n`);
	emit_asm(status, `ldp x19, x20, [sp], #16\n`);
}
