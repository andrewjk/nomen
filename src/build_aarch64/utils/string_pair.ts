import type BuildStatus from "../../build_c/BuildStatus.ts";
import aarch64_size from "./aarch64_size.ts";
import { emit_free, emit_malloc, emit_strdup } from "./audit.ts";
import { emit_asm } from "./code_buffer.ts";

/**
 * Fat-string register-pair helpers (aarch64).
 *
 * A `string` value is the 16-byte { char* ptr; long len; } pair:
 *   - in registers: two CONSECUTIVE x-registers (ptr, len) — the same AAPCS
 *     shape `view T` uses;
 *   - in memory: one 16-byte slot (ptr at +0, len at +8), stack- or
 *     struct-field-resident.
 *
 * Every string move goes through these helpers so no site accidentally
 * moves only the pointer half.
 */

/** Whether a type name denotes the fat string. */
export function is_string_type_name(name: string | undefined): boolean {
	return name === "string";
}

/** Byte size of a fat-string slot (16). */
export function STRING_SIZE(): number {
	return aarch64_size("string");
}

/**
 * Load the string variable `name` into the consecutive register pair
 * (base, base+1) — default x0/x1. Handles the plain slot case; callers
 * that have register-allocated or param forms handle theirs first.
 */
export function emit_string_pair_load(status: BuildStatus, name: string, base = "x0"): boolean {
	const offset = status.stack_offsets?.get(name);
	if (offset === undefined) return false;
	const w = base.startsWith("x") ? base : "x0";
	const n = parseInt(w.substring(1), 10);
	// ldp/stp simm7-scaled range tops out at +504 — split beyond it.
	if (offset + 8 > 504) {
		emit_asm(status, `ldr ${w}, [x29, #${offset}]\n`);
		emit_asm(status, `ldr x${n + 1}, [x29, #${offset + 8}]\n`);
		return true;
	}
	emit_asm(status, `ldp ${w}, x${n + 1}, [x29, #${offset}]\n`);
	return true;
}

/** Store the register pair (base, base+1) into the string variable's slot. */
export function emit_string_pair_store(status: BuildStatus, name: string, base = "x0"): boolean {
	const offset = status.stack_offsets?.get(name);
	if (offset === undefined) return false;
	const w = base.startsWith("x") ? base : "x0";
	const n = parseInt(w.substring(1), 10);
	if (offset + 8 > 504) {
		emit_asm(status, `str ${w}, [x29, #${offset}]\n`);
		emit_asm(status, `str x${n + 1}, [x29, #${offset + 8}]\n`);
		return true;
	}
	emit_asm(status, `stp ${w}, x${n + 1}, [x29, #${offset}]\n`);
	return true;
}

/** Store the pair in (base, base+1) to [addr_reg, #offset]. */
export function emit_string_pair_store_at(
	status: BuildStatus,
	addr_reg: string,
	offset: number,
	base = "x0",
) {
	const w = base.startsWith("x") ? base : "x0";
	const n = parseInt(w.substring(1), 10);
	emit_asm(status, `stp ${w}, x${n + 1}, [${addr_reg}, #${offset}]\n`);
}

/** Load the pair at [addr_reg, #offset] into (base, base+1). */
export function emit_string_pair_load_at(
	status: BuildStatus,
	addr_reg: string,
	offset: number,
	base = "x0",
) {
	const w = base.startsWith("x") ? base : "x0";
	const n = parseInt(w.substring(1), 10);
	emit_asm(status, `ldp ${w}, x${n + 1}, [${addr_reg}, #${offset}]\n`);
}

/**
 * strdup the fat string in (x0=ptr, x1=len): preserve the len half across
 * the call and leave the owned copy's pair in (x0, x1). The caller keeps
 * ownership of the original.
 */
export function emit_strdup_string(status: BuildStatus) {
	emit_asm(status, `str x1, [sp, #-16]!\n`);
	emit_asm(status, status.audit ? `bl _nomen_strdup_wrap\n` : `bl _strdup\n`);
	emit_asm(status, `ldr x1, [sp], #16\n`);
}

/** free(ptr-half) of the fat value whose ptr is in x0. */
export function emit_free_string_ptr(status: BuildStatus) {
	emit_asm(status, status.audit ? `bl _nomen_free_wrap\n` : `bl _free\n`);
}

/**
 * Pair load/store at [x29, #offset] with an arbitrary register pair —
 * splits into two single-word accesses beyond the ldp/stp +504 range.
 */
export function emit_pair_load_x29(status: BuildStatus, offset: number, a = "x0", b = "x1") {
	if (offset + 8 > 504) {
		emit_asm(status, `ldr ${a}, [x29, #${offset}]\n`);
		emit_asm(status, `ldr ${b}, [x29, #${offset + 8}]\n`);
		return;
	}
	emit_asm(status, `ldp ${a}, ${b}, [x29, #${offset}]\n`);
}

export function emit_pair_store_x29(status: BuildStatus, offset: number, a = "x0", b = "x1") {
	if (offset + 8 > 504) {
		emit_asm(status, `str ${a}, [x29, #${offset}]\n`);
		emit_asm(status, `str ${b}, [x29, #${offset + 8}]\n`);
		return;
	}
	emit_asm(status, `stp ${a}, ${b}, [x29, #${offset}]\n`);
}

/**
 * Owning specializations for Array<string>'s raw T-generic bodies
 * (`with` / `set`), replacing the shared-pointer copies with per-slot deep
 * copies — the aarch64 analog of Array.nm's `#if T_NEEDS_STRDUP` C branch.
 *
 * Conventions (matching Array.nm raw bodies):
 *   - `with`  (static): x0/x1 = value pair, x2 = count. Returns x0 = heap
 *     buffer ([ptr] = length, elements at +8..).
 *   - `set`   (method): x19 = first element, x1 = index, x2/x3 = value pair.
 * Bounds are guaranteed by the Nomen-level constraints.
 */
export function emit_owning_array_string_specialize(
	func_name: string,
	status: BuildStatus,
	self_reg = "x19",
): boolean {
	if (func_name === "with") {
		// Entry: x0 = value.ptr, x1 = value.len, x2 = count.
		emit_asm(status, `stp x19, x20, [sp, #-16]!\n`);
		emit_asm(status, `stp x21, x22, [sp, #-16]!\n`);
		emit_asm(status, `stp x24, x25, [sp, #-16]!\n`);
		emit_asm(status, `mov x19, x0\n`); // value ptr
		emit_asm(status, `mov x20, x1\n`); // value len
		emit_asm(status, `mov x21, x2\n`); // count
		// malloc(8 + count * 16)
		emit_asm(status, `add x0, x21, #1\n`);
		emit_asm(status, `lsl x0, x0, #4\n`);
		emit_malloc(status);
		emit_asm(status, `mov x22, x0\n`);
		emit_asm(status, `str x21, [x22]\n`); // length prefix
		emit_asm(status, `mov x23, #8\n`); // byte cursor (first slot)
		emit_asm(status, `mov x24, #0\n`); // i
		emit_asm(status, `.Larr_str_with_loop:\n`);
		emit_asm(status, `cmp x24, x21\n`);
		emit_asm(status, `b.ge .Larr_str_with_done\n`);
		emit_asm(status, `mov x0, x19\n`);
		emit_strdup(status);
		// slot address = buf + cursor (stp has no register-offset form).
		emit_asm(status, `add x25, x22, x23\n`);
		emit_asm(status, `stp x0, x20, [x25]\n`); // slot = {dup, len}
		emit_asm(status, `add x23, x23, #16\n`);
		emit_asm(status, `add x24, x24, #1\n`);
		emit_asm(status, `b .Larr_str_with_loop\n`);
		emit_asm(status, `.Larr_str_with_done:\n`);
		emit_asm(status, `mov x0, x22\n`);
		emit_asm(status, `ldp x24, x25, [sp], #16\n`);
		emit_asm(status, `ldp x21, x22, [sp], #16\n`);
		emit_asm(status, `ldp x19, x20, [sp], #16\n`);
		return true;
	}
	if (func_name === "at" || func_name === "first" || func_name === "at_end") {
		// Pair-RETURNING loads: the raw T-generic body would sret-copy a
		// 16-byte element through x8, but string returns ride the (x0, x1)
		// register pair.
		emit_asm(status, `stp x20, x21, [sp, #-16]!\n`);
		if (func_name === "at") {
			emit_asm(status, `lsl x9, x1, #4\n`);
			emit_asm(status, `add x9, ${self_reg}, x9\n`);
		} else if (func_name === "at_end") {
			emit_asm(status, `ldr x9, [${self_reg}, #-8]\n`); // length
			emit_asm(status, `sub x9, x9, #1\n`);
			emit_asm(status, `lsl x9, x9, #4\n`);
			emit_asm(status, `add x9, ${self_reg}, x9\n`);
		} else {
			emit_asm(status, `add x9, ${self_reg}, #0\n`);
		}
		emit_asm(status, `ldp x0, x1, [x9]\n`);
		emit_asm(status, `ldp x20, x21, [sp], #16\n`);
		return true;
	}
	if (func_name === "set") {
		// Entry: self_reg = first element, x1 = index, x2/x3 = value pair.
		emit_asm(status, `stp x20, x21, [sp, #-16]!\n`);
		emit_asm(status, `lsl x9, x1, #4\n`);
		emit_asm(status, `add x9, ${self_reg}, x9\n`); // &slot[index]
		// Free the outgoing value. x2/x3 are caller-saved and _free clobbers
		// them, so the incoming value pair parks in x20/x21 (saved above).
		emit_asm(status, `ldr x0, [x9]\n`);
		emit_asm(status, `mov x20, x2\n`);
		emit_asm(status, `mov x21, x3\n`);
		emit_free(status);
		// Deep-copy the incoming value.
		emit_asm(status, `mov x0, x20\n`);
		emit_strdup(status);
		emit_asm(status, `str x0, [x9]\n`);
		emit_asm(status, `str x21, [x9, #8]\n`);
		emit_asm(status, `ldp x20, x21, [sp], #16\n`);
		return true;
	}
	return false;
}

/** Pair store to [base_reg, #offset] with stur fallback (misaligned/far). */
export function emit_pair_store_to(
	status: BuildStatus,
	base_reg: string,
	offset: number,
	a: string,
	b: string,
) {
	const ok = offset % 8 === 0 && offset + 8 <= 504 && offset >= 0;
	if (ok) {
		emit_asm(status, `stp ${a}, ${b}, [${base_reg}, #${offset}]\n`);
	} else {
		emit_asm(status, `stur ${a}, [${base_reg}, #${offset}]\n`);
		emit_asm(status, `stur ${b}, [${base_reg}, #${offset + 8}]\n`);
	}
}
