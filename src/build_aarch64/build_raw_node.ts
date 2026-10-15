import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import RawNode from "../nodes/RawNode.ts";
import { check_raw_arch_coverage, parse_raw_directives } from "../raw_directives.ts";
import { asm_code_len, emit_asm } from "./utils/code_buffer.ts";
import { raw_reload_lines_for } from "./utils/raw_reload.ts";
import { get_enum_sret_size, get_struct_size } from "./utils/struct_layout.ts";

export default function build_raw_node(node: RawNode, status: BuildStatus) {
	const { should_emit, code, is_c, scope } = parse_raw_directives(
		node.value,
		"aarch64",
		status.platform,
	);
	if (!should_emit || !code) return;

	if (is_c) {
		if (scope === "file") {
			// File-scope C: emit to file_scope_c (companion file, before functions).
			if (!status.file_scope_c) status.file_scope_c = "";
			status.file_scope_c += `${code}\n`;
		} else {
			// Block-scope C companion code.
			if (!status.c_companion) status.c_companion = "";
			status.c_companion += `${code}\n`;
		}
	} else {
		// A raw asm block reads its parameters from the entry ABI registers
		// (x0, x1, …), but it is spliced verbatim wherever its statement
		// sits — after any control flow or expression evaluation those
		// registers hold scratch values. Away from the body's entry point,
		// re-establish the entry values first: the prologue parked each
		// register-slot param in a home (stack slot or callee-saved
		// register) that stays live at every statement boundary. Only the
		// registers the block actually names are reloaded.
		for (const line of raw_reload_lines_for(code, status.raw_param_reloads, asm_code_len(status))) {
			emit_asm(status, `${line}\n`);
		}
		emit_asm(status, `${code}\n`);
	}
}

function get_func_label(
	func: FunctionNode,
	struct_name: string | undefined,
	status: BuildStatus,
): string {
	if (struct_name) {
		const struct = status.structs.find((s) => s.name === struct_name);
		if (struct && is_overloaded(struct, func.name)) {
			return mangled_label(func, struct_name);
		}
		return `${struct_name}_${func.name.replace(/#/g, "")}`;
	}
	return func.name === "main" ? "_nomen_main" : func.name;
}

/**
 * Checks whether a function should be skipped in the aarch64 assembly output
 * because its body is provided as C via `aarch64_use_c` raw blocks.
 *
 * If the function IS a C-fallback, its raw C code and metadata are collected
 * onto `status.c_companion_functions` for later companion-file generation,
 * and `true` is returned (caller should skip assembly emission).
 *
 * If the function has raw blocks targeting other architectures but none
 * matching aarch64 (no `aarch64` or `aarch64_use_c`), a build error is
 * recorded and `false` is returned (the function will still be built, likely
 * producing incomplete output that the error message explains).
 */
export function check_c_fallback(
	func: FunctionNode,
	struct_name: string | undefined,
	status: BuildStatus,
): boolean {
	const coverage = check_raw_arch_coverage(func, "aarch64", status.platform);

	// Error: raw blocks exist for other arches but none for the target.
	if (!coverage.has_match && coverage.has_other_arch) {
		if (!status.build_errors) status.build_errors = [];
		const label = struct_name ? `${struct_name}.${func.name.replace(/#/g, "")}` : func.name;
		status.build_errors.push({
			message: `Function ${label} has raw blocks for other architectures but no aarch64 or aarch64_use_c block`,
			start: func.start,
		});
		return false;
	}

	// Collect C-fallback code if present. `#scope: file` blocks are routed
	// to the companion's file scope (file_scope_c) rather than inlined into
	// the function body — in-body they'd become nested functions/globals, so
	// a delegate IMP (which needs a stable file-scope address) couldn't be
	// registered. Block-scope code becomes the function body as before.
	let raw_code = "";
	let file_scope_code = "";
	let is_c_fallback = false;
	for (const stmt of func.statements) {
		if (stmt.node_type !== "raw") continue;
		const parsed = parse_raw_directives((stmt as RawNode).value, "aarch64", status.platform);
		if (parsed.should_emit && parsed.is_c && parsed.code) {
			is_c_fallback = true;
			if (parsed.scope === "file") {
				file_scope_code += parsed.code + "\n";
			} else {
				raw_code += parsed.code + "\n";
			}
		}
	}

	// Float params or return? When yes, the C companion's clang-compiled ABI
	// (floats in the d file) diverges from the Nomen call ABI (floats as raw
	// bits in x registers) and the bare label must become a bridge thunk.
	let float_bridge = has_float_abi_divergence(func);
	if (float_bridge && func.params.some((p) => p.is_variadic)) {
		if (!status.build_errors) status.build_errors = [];
		const label = struct_name ? `${struct_name}.${func.name.replace(/#/g, "")}` : func.name;
		status.build_errors.push({
			message: `Function ${label} mixes variadic params with floats — no aarch64_use_c ABI thunk for that shape`,
			start: func.start,
		});
		float_bridge = false;
	}

	if (is_c_fallback) {
		if (file_scope_code) {
			if (!status.file_scope_c) status.file_scope_c = "";
			status.file_scope_c += file_scope_code;
		}
		if (!status.c_companion_functions) status.c_companion_functions = [];
		status.c_companion_functions.push({
			func,
			struct_name,
			raw_code,
			bridge_c_abi: float_bridge,
		});

		// Emit an assembly thunk when the companion's C ABI diverges from the
		// Nomen call ABI:
		//
		// 1. Struct returns ≤ 16 bytes. The aarch64 backend uses x8
		//    (caller-allocated buffer) for ALL struct returns — and, like
		//    structs, for all enum-with-data returns — but the standard ARM64
		//    ABI used by the C companion returns small structs in registers
		//    x0/x1. The thunk bridges the gap. (> 16-byte returns already ride
		//    C's hidden-pointer sret, which matches x8 naturally.)
		// 2. Float params/returns. Nomen's call ABI passes every scalar in an
		//    x register (floats as raw bits), while clang-compiled companion
		//    code expects floats per AAPCS64 in the d file (and returns them
		//    in d0).
		//
		// A `#init` is exempt from (1): class OR struct, the ctor convention
		// is x0 = &instance + in-place mutation (see generate_c_function) — a
		// struct-return thunk here would collide with it and store through
		// the never-staged x8. A ctor with floats still gets a thunk for (2):
		// it forwards x0 (the instance) unchanged and only shuffles the
		// float bits to the d file.
		const is_ctor = func.name === "#init" && !!struct_name;
		const return_type = is_ctor ? "" : func.return_type?.name || "";
		const return_struct = status.structs.find(
			(s) => s.name === return_type && !s.is_simple_type && !s.is_class,
		);
		const enum_sret_size = get_enum_sret_size(return_type, status);
		let sret_size: number | undefined;
		if (return_struct) {
			const struct_size = get_struct_size(return_type, status);
			if (struct_size <= 16) {
				sret_size = struct_size;
			}
		} else if (enum_sret_size !== undefined) {
			if (enum_sret_size <= 16) {
				sret_size = enum_sret_size;
			}
		}
		if (float_bridge) {
			emit_c_abi_thunk(func, struct_name, status, is_ctor ? undefined : sret_size);
		} else if (!is_ctor && sret_size !== undefined) {
			emit_c_abi_thunk(func, struct_name, status, sret_size);
		}

		return true;
	}

	return false;
}

/**
 * Does this parameter type ride the C ABI's d-register file? Nomen `float*`
 * types are 64-bit doubles (`c_type: "double"`).
 */
function is_float_type_name(name: string): boolean {
	return name.startsWith("float") || name.startsWith("ufloat");
}

/** Any float param, or a float return? (see emit_c_abi_thunk case 2) */
function has_float_abi_divergence(func: FunctionNode): boolean {
	if (is_float_type_name(func.return_type?.name || "")) return true;
	return func.params.some((p) => !p.is_variadic && is_float_type_name(p.type.name));
}

function emit_c_abi_thunk(
	func: FunctionNode,
	struct_name: string | undefined,
	status: BuildStatus,
	struct_size: number | undefined,
): void {
	const func_label = get_func_label(func, struct_name, status);
	const c_label = `${func_label}_c`;
	const words = struct_size !== undefined ? Math.ceil(struct_size / 8) : 0;
	const return_is_float = is_float_type_name(func.return_type?.name || "");

	emit_asm(status, `.p2align 2\n`);
	emit_asm(status, `${func_label}:\n`);
	emit_asm(status, `stp x29, x30, [sp, #-16]!\n`);
	emit_asm(status, `mov x29, sp\n`);
	if (struct_size !== undefined) {
		emit_asm(status, `sub sp, sp, #16\n`);
		emit_asm(status, `str x8, [sp, #0]\n`);
	}

	// Re-assign every parameter to its C-ABI register. Non-float params keep
	// x registers on both sides — but only their POSITION differs when floats
	// precede them (a float consumes an incoming x slot, no outgoing x slot),
	// so integer params may shift down. Floats move x bits to d slots. Move
	// the floats FIRST (fmov reads x, writes d — it cannot clobber a slot a
	// later x move needs), then the x moves in REVERSE param order so an
	// earlier param's shifted destination is never a later param's unread
	// source (same argument as build_foreign).
	let in_slot = 0;
	let out_x = 0;
	let out_d = 0;
	const x_moves: { out: number; in: number }[] = [];
	const d_moves: { out: number; in: number }[] = [];
	for (const param of func.params) {
		if (is_float_type_name(param.type.name)) {
			d_moves.push({ out: out_d++, in: in_slot });
			in_slot += 1;
			continue;
		}
		// A 16-byte composite (fat string / view) rides a register PAIR on
		// both sides — same slot count in and out.
		const wide = param.type.name === "string" || param.type.is_view;
		const slots = wide ? 2 : 1;
		x_moves.push({ out: out_x, in: in_slot });
		out_x += slots;
		in_slot += slots;
	}
	for (const m of d_moves) {
		emit_asm(status, `fmov d${m.out}, x${m.in}\n`);
	}
	for (let i = x_moves.length - 1; i >= 0; i--) {
		const { out, in: inc } = x_moves[i];
		if (out !== inc) {
			emit_asm(status, `mov x${out}, x${inc}\n`);
		}
	}

	emit_asm(status, `bl ${c_label}\n`);
	if (struct_size !== undefined) {
		emit_asm(status, `ldr x8, [sp, #0]\n`);
		for (let i = 0; i < words; i++) {
			const reg = i === 0 ? "x0" : i === 1 ? "x1" : `x${i}`;
			emit_asm(status, `str ${reg}, [x8, #${i * 8}]\n`);
		}
		emit_asm(status, `add sp, sp, #16\n`);
	} else if (return_is_float) {
		// The C body returned the float in d0; the Nomen ABI reads it as bits
		// in x0.
		emit_asm(status, `fmov x0, d0\n`);
	}
	emit_asm(status, `ldp x29, x30, [sp], #16\n`);
	emit_asm(status, `ret\n`);
}
