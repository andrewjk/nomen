import type BuildStatus from "../../build_c/BuildStatus.ts";
import aarch64_size from "./aarch64_size.ts";
import { emit_free, emit_malloc, emit_strdup } from "./audit.ts";

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
		status.code += `ldr ${w}, [x29, #${offset}]\n`;
		status.code += `ldr x${n + 1}, [x29, #${offset + 8}]\n`;
		return true;
	}
	status.code += `ldp ${w}, x${n + 1}, [x29, #${offset}]\n`;
	return true;
}

/** Store the register pair (base, base+1) into the string variable's slot. */
export function emit_string_pair_store(status: BuildStatus, name: string, base = "x0"): boolean {
	const offset = status.stack_offsets?.get(name);
	if (offset === undefined) return false;
	const w = base.startsWith("x") ? base : "x0";
	const n = parseInt(w.substring(1), 10);
	if (offset + 8 > 504) {
		status.code += `str ${w}, [x29, #${offset}]\n`;
		status.code += `str x${n + 1}, [x29, #${offset + 8}]\n`;
		return true;
	}
	status.code += `stp ${w}, x${n + 1}, [x29, #${offset}]\n`;
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
	status.code += `stp ${w}, x${n + 1}, [${addr_reg}, #${offset}]\n`;
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
	status.code += `ldp ${w}, x${n + 1}, [${addr_reg}, #${offset}]\n`;
}

/**
 * strdup the fat string in (x0=ptr, x1=len): preserve the len half across
 * the call and leave the owned copy's pair in (x0, x1). The caller keeps
 * ownership of the original.
 */
export function emit_strdup_string(status: BuildStatus) {
	status.code += `str x1, [sp, #-16]!\n`;
	status.code += status.audit ? `bl _nomen_strdup_wrap\n` : `bl _strdup\n`;
	status.code += `ldr x1, [sp], #16\n`;
}

/** free(ptr-half) of the fat value whose ptr is in x0. */
export function emit_free_string_ptr(status: BuildStatus) {
	status.code += status.audit ? `bl _nomen_free_wrap\n` : `bl _free\n`;
}

/**
 * Pair load/store at [x29, #offset] with an arbitrary register pair —
 * splits into two single-word accesses beyond the ldp/stp +504 range.
 */
export function emit_pair_load_x29(status: BuildStatus, offset: number, a = "x0", b = "x1") {
	if (offset + 8 > 504) {
		status.code += `ldr ${a}, [x29, #${offset}]\n`;
		status.code += `ldr ${b}, [x29, #${offset + 8}]\n`;
		return;
	}
	status.code += `ldp ${a}, ${b}, [x29, #${offset}]\n`;
}

export function emit_pair_store_x29(status: BuildStatus, offset: number, a = "x0", b = "x1") {
	if (offset + 8 > 504) {
		status.code += `str ${a}, [x29, #${offset}]\n`;
		status.code += `str ${b}, [x29, #${offset + 8}]\n`;
		return;
	}
	status.code += `stp ${a}, ${b}, [x29, #${offset}]\n`;
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
		status.code += `stp x19, x20, [sp, #-16]!\n`;
		status.code += `stp x21, x22, [sp, #-16]!\n`;
		status.code += `stp x24, x25, [sp, #-16]!\n`;
		status.code += `mov x19, x0\n`; // value ptr
		status.code += `mov x20, x1\n`; // value len
		status.code += `mov x21, x2\n`; // count
		// malloc(8 + count * 16)
		status.code += `add x0, x21, #1\n`;
		status.code += `lsl x0, x0, #4\n`;
		emit_malloc(status);
		status.code += `mov x22, x0\n`;
		status.code += `str x21, [x22]\n`; // length prefix
		status.code += `mov x23, #8\n`; // byte cursor (first slot)
		status.code += `mov x24, #0\n`; // i
		status.code += `.Larr_str_with_loop:\n`;
		status.code += `cmp x24, x21\n`;
		status.code += `b.ge .Larr_str_with_done\n`;
		status.code += `mov x0, x19\n`;
		emit_strdup(status);
		// slot address = buf + cursor (stp has no register-offset form).
		status.code += `add x25, x22, x23\n`;
		status.code += `stp x0, x20, [x25]\n`; // slot = {dup, len}
		status.code += `add x23, x23, #16\n`;
		status.code += `add x24, x24, #1\n`;
		status.code += `b .Larr_str_with_loop\n`;
		status.code += `.Larr_str_with_done:\n`;
		status.code += `mov x0, x22\n`;
		status.code += `ldp x24, x25, [sp], #16\n`;
		status.code += `ldp x21, x22, [sp], #16\n`;
		status.code += `ldp x19, x20, [sp], #16\n`;
		return true;
	}
	if (func_name === "at" || func_name === "first" || func_name === "at_end") {
		// Pair-RETURNING loads: the raw T-generic body would sret-copy a
		// 16-byte element through x8, but string returns ride the (x0, x1)
		// register pair.
		status.code += `stp x20, x21, [sp, #-16]!\n`;
		if (func_name === "at") {
			status.code += `lsl x9, x1, #4\n`;
			status.code += `add x9, ${self_reg}, x9\n`;
		} else if (func_name === "at_end") {
			status.code += `ldr x9, [${self_reg}, #-8]\n`; // length
			status.code += `sub x9, x9, #1\n`;
			status.code += `lsl x9, x9, #4\n`;
			status.code += `add x9, ${self_reg}, x9\n`;
		} else {
			status.code += `add x9, ${self_reg}, #0\n`;
		}
		status.code += `ldp x0, x1, [x9]\n`;
		status.code += `ldp x20, x21, [sp], #16\n`;
		return true;
	}
	if (func_name === "set") {
		// Entry: self_reg = first element, x1 = index, x2/x3 = value pair.
		status.code += `stp x20, x21, [sp, #-16]!\n`;
		status.code += `lsl x9, x1, #4\n`;
		status.code += `add x9, ${self_reg}, x9\n`; // &slot[index]
		// Free the outgoing value.
		status.code += `ldr x0, [x9]\n`;
		emit_free(status);
		// Deep-copy the incoming value.
		status.code += `mov x0, x2\n`;
		emit_strdup(status);
		status.code += `str x0, [x9]\n`;
		status.code += `str x3, [x9, #8]\n`;
		status.code += `ldp x20, x21, [sp], #16\n`;
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
		status.code += `stp ${a}, ${b}, [${base_reg}, #${offset}]\n`;
	} else {
		status.code += `stur ${a}, [${base_reg}, #${offset}]\n`;
		status.code += `stur ${b}, [${base_reg}, #${offset + 8}]\n`;
	}
}
