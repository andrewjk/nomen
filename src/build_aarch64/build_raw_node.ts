import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import RawNode from "../nodes/RawNode.ts";
import { check_raw_arch_coverage, parse_raw_directives } from "../raw_directives.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

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
		status.code += `${code}\n`;
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
	return func.name === "main" ? "_echo_main" : func.name;
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

	// Collect C-fallback code if present.
	let raw_code = "";
	let is_c_fallback = false;
	for (const stmt of func.statements) {
		if (stmt.node_type !== "raw") continue;
		const parsed = parse_raw_directives((stmt as RawNode).value, "aarch64", status.platform);
		if (parsed.should_emit && parsed.is_c && parsed.code) {
			is_c_fallback = true;
			raw_code += parsed.code + "\n";
		}
	}

	if (is_c_fallback) {
		if (!status.c_companion_functions) status.c_companion_functions = [];
		status.c_companion_functions.push({ func, struct_name, raw_code });

		// Emit an assembly thunk when the function returns a struct ≤ 16 bytes.
		// The aarch64 backend uses x8 (caller-allocated buffer) for ALL struct
		// returns, but the standard ARM64 ABI used by the C companion returns
		// small structs in registers x0/x1. The thunk bridges the gap.
		const return_type = func.return_type?.name || "";
		const return_struct = status.structs.find(
			(s) => s.name === return_type && !s.is_simple_type && !s.is_class,
		);
		if (return_struct) {
			const struct_size = get_struct_size(return_type, status);
			if (struct_size <= 16) {
				emit_struct_return_thunk(func, struct_name, status, struct_size);
			}
		}

		return true;
	}

	return false;
}

function emit_struct_return_thunk(
	func: FunctionNode,
	struct_name: string | undefined,
	status: BuildStatus,
	struct_size: number,
): void {
	const func_label = get_func_label(func, struct_name, status);
	const c_label = `${func_label}_c`;
	const words = Math.ceil(struct_size / 8);

	status.code += `.p2align 2\n`;
	status.code += `${func_label}:\n`;
	status.code += `stp x29, x30, [sp, #-16]!\n`;
	status.code += `sub sp, sp, #16\n`;
	status.code += `str x8, [sp, #0]\n`;
	status.code += `bl ${c_label}\n`;
	status.code += `ldr x8, [sp, #0]\n`;
	for (let i = 0; i < words; i++) {
		const reg = i === 0 ? "x0" : i === 1 ? "x1" : `x${i}`;
		if (i === 0) {
			status.code += `str ${reg}, [x8]\n`;
		} else {
			status.code += `str ${reg}, [x8, #${i * 8}]\n`;
		}
	}
	status.code += `add sp, sp, #16\n`;
	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;
}
