import type BuildStatus from "../../build_c/BuildStatus.ts";
import { struct_needs_destroy } from "../../build_common/destroy_analysis.ts";
import emission_label from "../../build_common/emission_label.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import { get_struct_size } from "./struct_layout.ts";

/**
 * Closure descriptor ABI for the aarch64 backend (CLOSURE.md). A
 * func-typed VALUE is a pointer to a 24-byte descriptor { code, env, owned }
 * embedded in the text stream as data (like string literals). `code` always
 * has the closure ABI (`code(env, args...)` — env in x0): lambdas are
 * emitted with the hidden env slot directly; a named function used as a
 * value gets an auto-generated register-shuffling thunk that tail-calls the
 * unchanged original.
 *
 * Signatures stay one word everywhere; only indirect calls grow the env.
 */

/**
 * Emit the adrp+add sequence that materializes a descriptor's ADDRESS into
 * `reg`. Descriptors live in __DATA (see below), so a plain `adr` cannot
 * reach them.
 */
export function emit_descriptor_address(
	status: BuildStatus,
	reg: string,
	descriptor: string,
): void {
	status.code += `adrp ${reg}, ${descriptor}@PAGE\n`;
	status.code += `add ${reg}, ${reg}, ${descriptor}@PAGEOFF\n`;
}

/** Byte size of one capture's env field: 16-byte fat strings, the struct's
 *  own size for value structs (Phase 2c), 8 for scalars — 8-byte aligned. */
export function capture_size_a64(
	cap: { type: { name: string; is_view?: boolean; is_array?: boolean } },
	status: BuildStatus,
): number {
	if (cap.type.name === "string" && !cap.type.is_view && !cap.type.is_array) return 16;
	const elem = status.structs.find((s) => s.name === cap.type.name && !s.is_simple_type);
	if (elem && !elem.is_class) {
		return Math.ceil(get_struct_size(cap.type.name, status) / 8) * 8;
	}
	return 8;
}

/** Env layout for a capturing lambda: name → byte offset, and total size. */
export function closure_env_layout_a64(
	func: FunctionNode,
	status: BuildStatus,
): {
	offsets: Map<string, number>;
	size: number;
} {
	const offsets = new Map<string, number>();
	let off = 0;
	for (const cap of func.captures ?? []) {
		offsets.set(cap.name, off);
		off += capture_size_a64(cap, status);
	}
	return { offsets, size: off };
}

/**
 * Emit (once) the asm env destructor for a capturing lambda whose env owns
 * heap values. Phase 2b: captured strings are strdup'd in. Phase 2c part 2:
 * owning value structs, classes and func descriptors are MOVED in, so the
 * destructor destroys/reclaims them (the moved-in value is owned here).
 * Returns the destructor label, or undefined when the env owns nothing.
 */
export function emit_env_free_a64(func: FunctionNode, status: BuildStatus): string | undefined {
	const owned = (func.captures ?? []).some((c) => {
		if (c.type.name === "string" && !c.type.is_view && !c.type.is_array) return true;
		if (c.type.name === "func") return true;
		if (status.traits.find((t) => t.name === c.type.name)) return true;
		const elem = status.structs.find((s) => s.name === c.type.name);
		if (!elem || elem.is_simple_type) return false;
		if (elem.is_class) return true;
		return !!c.is_move; // owning value structs are destroyed; copies just free
	});
	if (!owned) return undefined;
	const label = `_nomen_env_free_${emission_label(func)}`;
	if (!status.closure_descriptors) status.closure_descriptors = new Map();
	const guard = `env_free:${label}`;
	if (status.closure_descriptors.has(guard)) return label;
	status.closure_descriptors.set(guard, label);
	const { offsets } = closure_env_layout_a64(func, status);
	const free_call = status.audit ? `bl _nomen_free_wrap\n` : `bl _free\n`;
	let body = `.p2align 2\n${label}:\nstp x29, x30, [sp, #-16]!\nstp x19, x20, [sp, #-16]!\nmov x19, x0\n`;
	for (const cap of func.captures ?? []) {
		const off = offsets.get(cap.name)!;
		const kind = (() => {
			if (cap.type.name === "string" && !cap.type.is_view && !cap.type.is_array) return "string";
			if (cap.type.name === "func") return "func";
			if (status.traits.find((t) => t.name === cap.type.name)) return "trait";
			const elem = status.structs.find((s) => s.name === cap.type.name);
			if (elem?.is_class) return "class";
			if (elem && !elem.is_simple_type) return "struct";
			return "scalar";
		})();
		if (kind === "string") {
			body += `ldr x0, [x19, #${off}]\n${free_call}`;
			continue;
		}
		if (kind === "func") {
			const skip = `.Lenv_skip_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
			const no_destroy = `.Lenv_nodestroy_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
			body += `ldr x0, [x19, #${off}]\n`;
			body += `cbz x0, ${skip}\n`;
			body += `ldr w9, [x0, #16]\n`;
			body += `cbz w9, ${skip}\n`;
			body += `ldr x10, [x0, #24]\n`;
			body += `cbz x10, ${no_destroy}\n`;
			body += `ldr x0, [x0, #8]\n`;
			body += `blr x10\n`;
			body += `${no_destroy}:\n`;
			body += `ldr x9, [x19, #${off}]\n`;
			body += `ldr x0, [x9, #8]\n`;
			body += free_call;
			body += `ldr x0, [x19, #${off}]\n`;
			body += free_call;
			body += `${skip}:\n`;
			continue;
		}
		if (kind === "class") {
			const skip = `.Lenv_skip_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
			body += `ldr x0, [x19, #${off}]\n`;
			body += `cbz x0, ${skip}\n`;
			body += `bl ${cap.type.name}_destroy\n`;
			body += `ldr x0, [x19, #${off}]\n`;
			body += free_call;
			body += `${skip}:\n`;
			continue;
		}
		if (kind === "trait") {
			// Dispatch through the trait's vtable destroy shim (the concrete
			// instance type may vary), then free the instance.
			const skip = `.Lenv_skip_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
			body += `ldr x0, [x19, #${off}]\n`;
			body += `cbz x0, ${skip}\n`;
			body += `bl ${cap.type.name}_destroy\n`;
			body += `ldr x0, [x19, #${off}]\n`;
			body += free_call;
			body += `${skip}:\n`;
			continue;
		}
		if (kind === "struct" && cap.is_move) {
			const elem = status.structs.find((s) => s.name === cap.type.name && !s.is_simple_type);
			if (elem && struct_needs_destroy(elem, status)) {
				body += `add x0, x19, #${off}\n`;
				body += `bl ${cap.type.name}_destroy\n`;
			}
			continue;
		}
	}
	body += `ldp x19, x20, [sp], #16\nldp x29, x30, [sp], #16\nret\n\n`;
	status.closure_definitions = (status.closure_definitions ?? "") + body;
	return label;
}

const DATA_SECTION_OPEN = `.section __DATA,__data\n`;
const TEXT_SECTION_RESTORE = `.text\n`;

/**
 * Emit (once per target per TU) the thunk + descriptor data for a named
 * function used as a func VALUE, and return the descriptor LABEL (adr-able).
 *
 * The thunk receives `(env, args...)` and shifts every argument slot down by
 * one (pair-aware: slot-by-slot ascending is a forward memmove), then
 * tail-calls the target (`b target` — LR still points at the thunk's
 * caller). The sret register (x8) passes through untouched.
 */
export function materialize_func_value_a64(func: FunctionNode, status: BuildStatus): string {
	if (!status.closure_descriptors) status.closure_descriptors = new Map();
	// NOTE: aarch64 function labels are the bare emission label (no
	// c_function_name mangling — build_function_node emits `${label_name}:`
	// directly), so the thunk's branch target uses the same form.
	const target = emission_label(func);
	const existing = status.closure_descriptors.get(target);
	if (existing) return existing;

	const thunk = `_nomen_closure_thunk_${target}`;
	const descriptor = `_nomen_closure_desc_${target}`;

	// Count the argument slots the thunk receives (env + visible params;
	// string/view pairs ride two slots; variadic packs a (ptr, len) pair).
	let slots = 1; // env
	for (const p of func.params ?? []) {
		if (p.is_self_param) continue;
		if (p.is_variadic) {
			slots += 2;
			continue;
		}
		if (p.type.is_array) {
			slots += 1;
			continue;
		}
		if (p.type.is_view || p.type.name === "string") {
			slots += 2;
			continue;
		}
		slots += 1;
	}

	const lines: string[] = [];
	lines.push(`.p2align 2`);
	lines.push(`${thunk}:`);
	// Shift every register arg down one slot (ascending = forward move).
	const reg_shift = Math.min(slots, 8);
	for (let s = 0; s < reg_shift - 1; s++) {
		lines.push(`mov x${s}, x${s + 1}`);
	}
	// Overflow args: incoming slot 8+k sits at [sp, #(k+1)*8] (the env was
	// slot 0, in a register), dest slot 8+k at [sp, #k*8]. No pushes were
	// made, so sp is the caller's.
	for (let k = 0; slots + k > 8 && k < 64; k++) {
		lines.push(`ldr x9, [sp, #${(k + 1) * 8}]`);
		lines.push(`str x9, [sp, #${k * 8}]`);
	}
	lines.push(`b ${target}`);
	lines.push(``);
	status.closure_definitions = (status.closure_definitions ?? "") + lines.join("\n") + "\n";

	// The descriptor is a plain function-pointer TABLE in __DATA (data→text
	// relocations are legal; text→text are NOT on arm64 Mach-O — which rules
	// out embedding the pointer in the text stream). Each flush wraps the
	// data in section switches and returns to __TEXT.
	status.closure_definitions =
		(status.closure_definitions ?? "") +
		DATA_SECTION_OPEN +
		`.p2align 3\n${descriptor}:\n\t.quad ${thunk}\n\t.quad 0\n\t.quad 0\n\t.quad 0\n` +
		TEXT_SECTION_RESTORE;

	status.closure_descriptors.set(target, descriptor);
	return descriptor;
}

/**
 * Emit (once per lambda per TU) the static descriptor for a capture-free
 * lambda and return the descriptor LABEL. The lambda itself has the closure
 * ABI (hidden env slot), so the descriptor points straight at it.
 */
export function materialize_lambda_descriptor_a64(func: FunctionNode, status: BuildStatus): string {
	if (!status.closure_descriptors) status.closure_descriptors = new Map();
	const code = emission_label(func);
	const existing = status.closure_descriptors.get(code);
	if (existing) return existing;
	const descriptor = `_nomen_closure_desc_${code}`;
	status.closure_definitions =
		(status.closure_definitions ?? "") +
		DATA_SECTION_OPEN +
		`.p2align 3\n${descriptor}:\n\t.quad ${code}\n\t.quad 0\n\t.quad 0\n\t.quad 0\n` +
		TEXT_SECTION_RESTORE;
	status.closure_descriptors.set(code, descriptor);
	return descriptor;
}
