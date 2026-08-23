import type BuildStatus from "../build_c/BuildStatus.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import RawNode from "../nodes/RawNode.ts";
import StructNode from "../nodes/StructNode.ts";
import { parse_raw_directives } from "../raw_directives.ts";
import build_block_node from "./build_block_node.ts";
import { emit_owning_buffer_inline_aarch64 } from "./utils/owning_buffer_specialize.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

let inline_counter = 0;

export function reset_inline_counter() {
	inline_counter = 0;
}

function is_raw_only(func: FunctionNode): boolean {
	return func.statements.every((s) => s.node_type === "raw");
}

function extract_aarch64_asm(func: FunctionNode, platform: string): string {
	let asm = "";
	for (const stmt of func.statements) {
		const raw = stmt as RawNode;
		const { should_emit, code } = parse_raw_directives(raw.value, "aarch64", platform);
		if (should_emit && code) {
			if (asm) asm += "\n";
			asm += code;
		}
	}
	return asm;
}

function count_x19_reads(asm: string): number {
	// Count real instruction operands only — asm comments (e.g. the
	// `// x19 = self` prologue notes in core raw bodies) mention registers
	// without reading them.
	const code = asm
		.split("\n")
		.map((l) => l.replace(/\/\/.*$/, ""))
		.join("\n");
	const matches = code.match(/\bx19\b/g);
	return matches ? matches.length : 0;
}

function build_naked_inline(struct_node: StructNode, func: FunctionNode, status: BuildStatus) {
	let asm = extract_aarch64_asm(func, status.platform);
	const standalone_return_label = `.return_${struct_node.name}_${func.name.replace(/#/g, "")}`;
	asm = asm.replaceAll(`b ${standalone_return_label}`, "");

	// The raw body is written for the standalone convention (x19 = self),
	// but the inline call site holds the receiver in x0. One x19 read can
	// be rewritten to x0 (cheapest); a body that reads x19 several times
	// (e.g. Array.at's per-width load arms) cannot — an arm may read x19
	// after x0 was already clobbered (the struct-element copy arm does
	// `mov x0, x8` first), so a blanket rewrite is unsound. Instead,
	// emulate the standalone prologue at the splice site: save the caller's
	// x19 (callee-saved, possibly holding a live value), install x0 into
	// x19, run the body, restore. A zero-read body needs neither.
	const x19_reads = count_x19_reads(asm);
	let prologue = "";
	let epilogue = "";
	if (x19_reads === 1) {
		asm = asm.replace(/\bx19\b/g, "x0");
	} else if (x19_reads > 1) {
		prologue = `str x19, [sp, #-16]!\nmov x19, x0\n`;
		epilogue = `ldr x19, [sp], #16\n`;
	}

	// Local labels in the raw body (`.L…`) are defined once per emission —
	// splicing the same body at multiple inline sites would define them
	// twice and fail to assemble. Rename every `.L…` token with a per-site
	// suffix (definitions and branch targets alike, consistently).
	// The suffix is `__ni<N>` (not `_<N>`): a bare numeric suffix collides
	// with a SIBLING method's mono-renamed width-arm labels — inlined `at`'s
	// `.L_Array__at_end` at site 1 became `.L_Array__at_end_1`, which is
	// exactly `at_end`'s own `.L_at_end_1` after rename_local_labels. The
	// letter-led `__ni` token is compiler-reserved and can't be produced
	// from a source label by the renamer.
	const site = inline_counter++;
	asm = asm.replace(/(\.L[A-Za-z0-9_]+)/g, `$1__ni${site}`);

	status.code += prologue + asm + "\n" + epilogue;
}

export default function build_inline_method(
	struct_node: StructNode,
	func: FunctionNode,
	status: BuildStatus,
) {
	// Specialize Buffer_<T> store_T / replace_T for owning value struct
	// elements (deep-copy string fields instead of plain shallow copy).
	if (emit_owning_buffer_inline_aarch64(struct_node, func.name, status)) return;

	const is_self_param = func.params[0]?.is_self_param;
	const self_is_var = is_self_param && func.params[0]?.declaration === "var";
	const needs_x19 = is_self_param && !self_is_var;

	// Raw-only inline funcs (e.g. `Math.sqrt`) emit a fixed asm snippet that
	// references the parameter registers (x0, x1, …) directly — the same
	// registers `build_access_node` already loaded the args into. The general
	// inline path below would needlessly shuffle each param into a callee-saved
	// register (x19/x20/…) that the raw body never reads, adding a
	// save/mov/restore triple per parameter. `build_naked_inline` just emits
	// the raw asm verbatim (with an x19→x0 rewrite when the body references
	// self), so prefer it for every raw-only inline func regardless of whether
	// it has a self parameter.
	if (is_raw_only(func)) {
		build_naked_inline(struct_node, func, status);
		return;
	}

	const old_scoped_declarations = status.scoped_declarations;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;
	const old_ref_params = status.function_ref_params;
	const old_struct_return_buffer = status.struct_return_buffer;
	const old_return_buffer_offset = status.return_buffer_stack_offset;
	const old_function_return_type = status.function_return_type;
	const old_register_allocations = status.register_allocations;
	const old_buffer_data_cache = status.buffer_data_cache;
	// The inline body's returns run emit_heap_slots_cleanup_for_return, which
	// frees EVERY frame on the cleanup stack. On the shared stack that would
	// free the OUTER function's live anchors (double-free once a later inline
	// return walks them again) — an inlined body owns only its own frames, so
	// swap in a fresh stack. `moved` is swapped for the same reason: marks made
	// inside the body must not leak out (and vice versa).
	const old_heap_cleanup_stack = status.heap_cleanup_stack;
	const old_moved = status.moved;
	// Mirror build_inline_function: hide the outer function's enclosing
	// scope frames so the inlined method's returns don't destroy the
	// caller's live locals.
	const old_outer_scope_declarations = status.outer_scope_declarations;
	// The inlined body's returns must be attributed to the INLINED method,
	// not the caller: build_return_node's string-ownership logic keys on
	// current_struct/current_function_name (e.g. borrow normalization
	// strdups a `load_T` borrow when the enclosing function is
	// heap-returning — an inlined `List<string>.at` inside `at_or` used to
	// inherit `at_or`'s classification and strdup twice, leaking one copy).
	// return_assign/join_needs_owned_string belong to the caller's join
	// slot too — the body's returns must not store through them.
	const old_current_struct = status.current_struct;
	const old_current_function_name = status.current_function_name;
	const old_return_assign = status.return_assign;
	const old_join_needs_owned_string = status.join_needs_owned_string;
	// A hoisted receiver/arg temp (`_recv_N`/`_param_N`) attached to a body
	// statement is per-SITE state: each inline emission needs its own copy
	// (own stack slot, own anchor). The per-build dedupe set would emit it
	// only at the first site (the standalone body or an earlier inline),
	// leaving later sites referencing a stack offset that isn't in their
	// swapped stack_offsets map.
	const old_emitted_allocations = status.emitted_allocations;

	const return_label = `.inline_ret_${inline_counter++}`;
	status.function_return_label = return_label;

	status.scoped_declarations = [];
	status.outer_scope_declarations = [];
	status.function_return_type = undefined;
	status.struct_return_buffer = undefined;
	status.return_buffer_stack_offset = undefined;
	status.buffer_data_cache = undefined;
	status.heap_cleanup_stack = [];
	status.moved = new Set();
	status.current_struct = struct_node;
	status.current_function_name = func.name;
	status.return_assign = undefined;
	status.join_needs_owned_string = undefined;
	status.emitted_allocations = new Set();

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

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_ref_params = new Set();

	if (needs_x19) {
		status.function_param_regs.set("self", "x19");
	}

	const saved_stack_slots: string[] = [];

	for (let i = 0; i < func.params.length; i++) {
		const param = func.params[i];
		if (param.is_self_param && !self_is_var) continue;
		// Enum-with-data args arrive as a pointer to the tag+payload blob —
		// same convention as struct args. A class arg is a heap pointer the
		// body reads as a value, so it stays in the callee-saved register path
		// (don't exclude it — see build_function_node for the full rationale).
		const is_struct_type =
			!!status.structs.find((s) => s.name === param.type.name && !s.is_simple_type) ||
			!!status.enums.find((e) => e.name === param.type.name && e.has_associated_data);
		if (is_struct_type && callee_idx < callee_saved.length) {
			const saved_reg = callee_saved[callee_idx++];
			if (saved_reg !== "x19" || !needs_x19) {
				status.code += `str ${saved_reg}, [sp, #-16]!\n`;
			}
			status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
			status.function_param_regs.set(param.name, saved_reg);
		} else if (!is_struct_type) {
			if (param.type.is_ref || callee_idx >= callee_saved.length) {
				status.code += `str ${param_regs[i]}, [sp, #-16]!\n`;
				saved_stack_slots.push(param.name);
			} else {
				const saved_reg = callee_saved[callee_idx++];
				if (saved_reg !== "x19" || !needs_x19) {
					status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				}
				status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
				status.function_param_regs.set(param.name, saved_reg);
			}
		}
		if (param.declaration === "var") {
			status.function_param_vars.add(param.name);
		}
		if (param.type.is_ref) {
			status.function_ref_params!.add(param.name);
		}
	}

	// An ARRAY-typed return (`out Array<T>`) is a heap buffer POINTER in x0 —
	// never sret, even when the element type is a struct.
	const return_struct =
		!func.return_type?.is_array &&
		!!status.structs.find(
			(s) => s.name === func.return_type?.name && !s.is_simple_type && !s.is_class,
		);
	if (return_struct) {
		status.function_return_type = func.return_type;
		status.struct_return_buffer = "x8";
		// x8 (the caller's sret destination) is caller-saved: any struct-
		// returning call inside the inline body sets its own x8, so spill the
		// incoming value to a frame slot — the return path reloads it before
		// the final struct copy (mirrors the standalone-function prologue).
		const return_buffer_stack_offset = allocate_stack_space(status, 8, 8);
		status.code += `str x8, [x29, #${return_buffer_stack_offset}]\n`;
		status.return_buffer_stack_offset = return_buffer_stack_offset;
	}

	// Snapshot the code length so the raw-body return-label rewrite below
	// only touches asm emitted for THIS inline body. A whole-buffer
	// replaceAll used to rewrite the standalone version's own return
	// branches (emitted earlier, e.g. `b .return_List_int_at` inside
	// `List_int_at` itself) into jumps to this inline site's label — the
	// standalone function fell into a random caller's code (segfault) —
	// and prefix-mangled sibling labels (`b .return_List_int_at_or` became
	// `b .inline_ret_N_or`, an undefined symbol).
	const code_length_before_body = status.code.length;

	build_block_node(func, status);

	// A raw block inside a (mixed) inline body may still branch to the
	// function's standalone return label — rewrite those to the inline
	// label. The trailing newline anchors the match so a method whose name
	// extends this one (`at` vs `at_or`) is never caught by prefix.
	const standalone_return_label = `.return_${struct_node.name}_${func.name.replace(/#/g, "")}`;
	const body = status.code.slice(code_length_before_body);
	status.code =
		status.code.slice(0, code_length_before_body) +
		body.replaceAll(`b ${standalone_return_label}\n`, `b ${return_label}\n`);

	status.code += `${return_label}:\n`;

	for (let i = saved_stack_slots.length - 1; i >= 0; i--) {
		status.code += `add sp, sp, #16\n`;
	}

	for (let ci = callee_idx - 1; ci >= 0; ci--) {
		if (callee_saved[ci] === "x19" && needs_x19) continue;
		status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
	}
	if (needs_x19) {
		status.code += `ldr x19, [sp], #16\n`;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.function_param_regs = old_param_regs;
	status.function_param_vars = old_param_vars;
	status.function_ref_params = old_ref_params;
	status.function_return_label = old_return_label;
	status.stack_offsets = old_stack_offsets;
	status.struct_return_buffer = old_struct_return_buffer;
	status.return_buffer_stack_offset = old_return_buffer_offset;
	status.function_return_type = old_function_return_type;
	status.register_allocations = old_register_allocations;
	status.buffer_data_cache = old_buffer_data_cache;
	status.heap_cleanup_stack = old_heap_cleanup_stack;
	status.moved = old_moved;
	status.outer_scope_declarations = old_outer_scope_declarations;
	status.current_struct = old_current_struct;
	status.current_function_name = old_current_function_name;
	status.return_assign = old_return_assign;
	status.join_needs_owned_string = old_join_needs_owned_string;
	status.emitted_allocations = old_emitted_allocations;
}

let inline_fn_depth = 0;
const MAX_INLINE_DEPTH = 2;

export function build_inline_function(func: FunctionNode, status: BuildStatus) {
	if (inline_fn_depth >= MAX_INLINE_DEPTH) return false;

	inline_fn_depth++;

	const old_scoped_declarations = status.scoped_declarations;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;
	const old_ref_params = status.function_ref_params;
	const old_struct_return_buffer = status.struct_return_buffer;
	const old_return_buffer_offset = status.return_buffer_stack_offset;
	const old_function_return_type = status.function_return_type;
	const old_register_allocations = status.register_allocations;
	const old_buffer_data_cache = status.buffer_data_cache;
	// See build_inline_method: an inlined body's returns must only clean up
	// anchors the body itself created — swap in a fresh cleanup stack (and a
	// fresh `moved` set) so the outer function's live anchors survive.
	const old_heap_cleanup_stack = status.heap_cleanup_stack;
	const old_moved = status.moved;
	// See build_inline_method: an inlined body's returns must only clean up
	// anchors the body itself created — swap in a fresh cleanup stack (and a
	// fresh `moved` set) so the outer function's live anchors survive.
	const old_outer_scope_declarations = status.outer_scope_declarations;
	// See build_inline_method: the body's returns are attributed to the
	// inlined function (not the caller), and hoisted per-site temps
	// re-emit at every inline site.
	const old_current_struct = status.current_struct;
	const old_current_function_name = status.current_function_name;
	const old_return_assign = status.return_assign;
	const old_join_needs_owned_string = status.join_needs_owned_string;
	const old_emitted_allocations = status.emitted_allocations;

	const return_label = `.inline_fn_ret_${inline_counter++}`;
	status.function_return_label = return_label;

	status.scoped_declarations = [];
	// The inline body's returns clean `all_scope_frames` — the outer
	// function's enclosing scope frames (pushed by enter_scope_frame around
	// the call site, e.g. a loop body) must NOT be visible, or the inlined
	// return destroys the caller's live locals mid-expression (e.g. an
	// inlined `base_code(c)` inside main's read loop freeing `data` before
	// the store into it).
	status.outer_scope_declarations = [];
	status.function_return_type = undefined;
	status.struct_return_buffer = undefined;
	status.return_buffer_stack_offset = undefined;
	status.buffer_data_cache = undefined;
	status.heap_cleanup_stack = [];
	status.moved = new Set();
	status.current_struct = undefined;
	status.current_function_name = func.name;
	status.return_assign = undefined;
	status.join_needs_owned_string = undefined;
	status.emitted_allocations = new Set();

	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const callee_saved = ["x19", "x20", "x21", "x22"];
	let callee_idx = 0;

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_ref_params = new Set();

	const saved_stack_slots: string[] = [];

	for (let i = 0; i < func.params.length; i++) {
		const param = func.params[i];
		if (param.is_self_param) continue;
		const is_struct_type = !!status.structs.find(
			(s) => s.name === param.type.name && !s.is_simple_type,
		);
		if (is_struct_type && callee_idx < callee_saved.length) {
			const saved_reg = callee_saved[callee_idx++];
			status.code += `str ${saved_reg}, [sp, #-16]!\n`;
			status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
			status.function_param_regs.set(param.name, saved_reg);
		} else if (!is_struct_type) {
			if (param.type.is_ref || callee_idx >= callee_saved.length) {
				status.code += `str ${param_regs[i]}, [sp, #-16]!\n`;
				saved_stack_slots.push(param.name);
			} else {
				const saved_reg = callee_saved[callee_idx++];
				status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
				status.function_param_regs.set(param.name, saved_reg);
			}
		}
		if (param.declaration === "var") {
			status.function_param_vars.add(param.name);
		}
		if (param.type.is_ref) {
			status.function_ref_params!.add(param.name);
		}
	}

	// An ARRAY-typed return is a heap buffer POINTER in x0 — never sret.
	const return_struct =
		!func.return_type?.is_array &&
		!!status.structs.find(
			(s) => s.name === func.return_type?.name && !s.is_simple_type && !s.is_class,
		);
	if (return_struct) {
		status.function_return_type = func.return_type;
		status.struct_return_buffer = "x8";
		// See build_inline_method: spill the caller's x8 sret pointer so an
		// inner struct-returning call can't clobber it before the return copy.
		const return_buffer_stack_offset = allocate_stack_space(status, 8, 8);
		status.code += `str x8, [x29, #${return_buffer_stack_offset}]\n`;
		status.return_buffer_stack_offset = return_buffer_stack_offset;
	}

	build_block_node(func, status);

	status.code += `${return_label}:\n`;

	for (let i = saved_stack_slots.length - 1; i >= 0; i--) {
		status.code += `add sp, sp, #16\n`;
	}

	for (let ci = callee_idx - 1; ci >= 0; ci--) {
		status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.function_param_regs = old_param_regs;
	status.function_param_vars = old_param_vars;
	status.function_ref_params = old_ref_params;
	status.function_return_label = old_return_label;
	status.stack_offsets = old_stack_offsets;
	status.struct_return_buffer = old_struct_return_buffer;
	status.return_buffer_stack_offset = old_return_buffer_offset;
	status.function_return_type = old_function_return_type;
	status.register_allocations = old_register_allocations;
	status.buffer_data_cache = old_buffer_data_cache;
	status.heap_cleanup_stack = old_heap_cleanup_stack;
	status.moved = old_moved;
	status.outer_scope_declarations = old_outer_scope_declarations;
	status.current_struct = old_current_struct;
	status.current_function_name = old_current_function_name;
	status.return_assign = old_return_assign;
	status.join_needs_owned_string = old_join_needs_owned_string;
	status.emitted_allocations = old_emitted_allocations;

	inline_fn_depth--;
	return true;
}
