import type BuildStatus from "../build_c/BuildStatus.ts";
import array_struct_name from "../build_c/utils/array_struct.ts";
import emission_label from "../build_common/emission_label.ts";
import { resolve_mono_type } from "../build_common/mono_name.ts";
import { moved_param_is_consumed } from "../build_common/scan_moved_param_consumed.ts";
import { ALL_FLOAT_TYPES } from "../built_in_types.ts";
import { lower_function } from "../nir/from_ast.ts";
import type { NirFunction, NirStmt } from "../nir/nir.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import type Type from "../nodes/Type.ts";
import build_block_node from "./build_block_node.ts";
import { check_c_fallback } from "./build_raw_node.ts";
import { nir_emission_enabled } from "./emit_nir.ts";
import { prepare_nir_forwarding } from "./forward.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free } from "./utils/audit.ts";
import { emit_destroy_for_anchor_slot } from "./utils/auto_destroy.ts";
import { plan_function_promotions } from "./utils/func_regalloc.ts";
import { nir_regalloc_enabled, plan_nir_registers } from "./utils/nir_regalloc.ts";
import scan_force_heap_strings from "./utils/scan_force_heap_strings.ts";
import {
	NUM_REG_ARGS,
	overflow_placeholder,
	patch_overflow_placeholders,
} from "./utils/stack_args.ts";
import { allocate_stack_space, emit_promoted_load } from "./utils/stack_var.ts";
import { get_enum_sret_size, get_field_offset, get_struct_size } from "./utils/struct_layout.ts";
import { value_number_loops, type VnPlan } from "./value_number.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

function peephole_optimize(code: string): string {
	const conditions: Record<string, string> = {
		eq: "ne",
		ne: "eq",
		gt: "le",
		ge: "lt",
		lt: "ge",
		le: "gt",
		hi: "ls",
		hs: "lo",
		lo: "hs",
		ls: "hi",
	};

	const lines = code.split("\n");

	// Pass 1: cset + cmp #0 + b.eq/b.ne → direct conditional branch
	{
		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === "") {
				out.push(lines[i]);
				continue;
			}
			const cset_match = lines[i].match(/^(\s*)cset x0, (\w+)\s*$/);
			if (cset_match) {
				let j = i + 1;
				while (j < lines.length && lines[j].trim() === "") j++;
				if (j < lines.length) {
					const cmp_match = lines[j].match(/^(\s*)cmp x0, #0\s*$/);
					if (cmp_match) {
						let k = j + 1;
						while (k < lines.length && lines[k].trim() === "") k++;
						if (k < lines.length) {
							const branch_match = lines[k].match(/^(\s*)b(eq|ne)\s+(\S+)\s*$/);
							if (branch_match) {
								const indent = cset_match[1];
								const cond = cset_match[2];
								const branch_cond = branch_match[2];
								const label = branch_match[3];
								if (branch_cond === "eq") {
									out.push(`${indent}b.${conditions[cond] || "ne"} ${label}`);
								} else {
									out.push(`${indent}b.${cond} ${label}`);
								}
								i = k;
								continue;
							}
						}
					}
				}
			}
			out.push(lines[i]);
		}
		lines.length = 0;
		lines.push(...out);
	}

	// Pass 2: eliminate immediately-adjacent str xN, [sp, #-16]! / ldr xN, [sp], #16
	// A push immediately followed by a pop of the same register is unconditionally a
	// no-op (sp unchanged, register unchanged). Only matches when no instructions
	// separate them (blank lines are OK). This removes the redundant spill/reload
	// that the assignment and declaration codegen inserts between computing a
	// value and storing it to a register-allocated variable.
	{
		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const push_match = lines[i].match(/^\s*str (x\d+|d\d+), \[sp, #-16\]!\s*$/);
			if (push_match) {
				const reg = push_match[1];
				let j = i + 1;
				while (j < lines.length && lines[j].trim() === "") j++;
				if (j < lines.length) {
					const esc_reg = reg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					const pop_re = new RegExp(`^\\s*ldr ${esc_reg}, \\[sp\\], #16\\s*$`);
					if (pop_re.test(lines[j])) {
						i = j;
						continue;
					}
				}
			}
			out.push(lines[i]);
		}
		lines.length = 0;
		lines.push(...out);
	}

	// Disabled - causes incorrect code generation for some patterns
	// {
	// 	const out: string[] = [];
	// 	for (let i = 0; i < lines.length; i++) {
	// 		const push_match = lines[i].match(/^(\s*)str x3, \[sp, #-16\]!\s*$/);
	// 		if (push_match) {
	// 			let j = i + 1;
	// 			let safe = true;
	// 			while (j < lines.length && !/^(\s*)ldr x3, \[sp\], #16\s*$/.test(lines[j])) {
	// 				const trimmed = lines[j].trim();
	// 				if (trimmed === "" || trimmed.startsWith("//")) {
	// 					j++;
	// 					continue;
	// 				}
	// 				if (/\bx3\b/.test(trimmed) || /\bsp\b/.test(trimmed)) {
	// 					safe = false;
	// 					break;
	// 				}
	// 				j++;
	// 			}
	// 			if (safe && j < lines.length && /^(\s*)ldr x3, \[sp\], #16\s*$/.test(lines[j])) {
	// 				i = j;
	// 				continue;
	// 			}
	// 		}
	// 		out.push(lines[i]);
	// 	}
	// 	lines.length = 0;
	// 	lines.push(...out);
	// }

	return lines.join("\n");
}

export default function build_function_node(node: FunctionNode, status: BuildStatus) {
	if (node.is_generic) return;
	if (check_c_fallback(node, undefined, status)) return;

	const old_function_name = status.current_function_name;
	status.current_function_name = emission_label(node);

	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];
	status.last_result_is_heap = false;

	// heap_strings / heap_string_arrays / heap_class_arrays are GLOBAL
	// structures that mark_heap_string / array-anchor paths append to. They
	// must be reset per function, or names marked by an EARLIER function leak
	// into a LATER function's scope-exit cleanup (which frees any local whose
	// name is in the set) — the canonical System build exposes this,
	// double-freeing unrelated locals (an int named `v`, an Array<char>
	// `letters`) after some other function marked the same name. Save/restore
	// so each function sees only its own marks.
	const old_heap_strings = status.heap_strings;
	status.heap_strings = new Set<string>();
	const old_heap_string_arrays = status.heap_string_arrays;
	status.heap_string_arrays = undefined;
	const old_heap_owned_string_arrays = status.heap_owned_string_arrays;
	status.heap_owned_string_arrays = undefined;
	const old_heap_class_arrays = status.heap_class_arrays;
	status.heap_class_arrays = undefined;
	const old_heap_array_vars = status.heap_array_vars;
	status.heap_array_vars = undefined;

	const old_moved: Set<string> | undefined = status.moved;
	(status.moved as Set<string> | undefined) = undefined;

	// Access-staging pins are per-function (prologue patching shifts code
	// positions at function exit — ASM_PLAN_3 tranche L).
	status.access_pins = undefined;
	status.forwarded_param_inits = undefined;

	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];

	const old_return_label = status.function_return_label;
	const return_label = `.return_${label_counter}`;
	const keep_prefix = `.Lkeep_${label_counter}`;
	label_counter++;
	status.function_return_label = return_label;

	const is_nested = !!old_return_label && node.name !== "main";

	let old_code: string | undefined;
	if (is_nested) {
		old_code = status.code;
		status.code = "";
	}

	// A `view T` return is a (ptr, len) pair in x0/x1 — never a sret struct,
	// even when the element T is itself a struct. Exclude views here so a
	// `view User` slice return isn't misclassified as a struct return.
	// An ARRAY-typed return (`out Array<T>`) is a heap buffer POINTER in x0 —
	// never sret, even when the element type is a struct.
	// First, normalize a generic-annotated return type (`Wrapper<List<int>>`)
	// to its mono struct form — layout/size resolution below keys on
	// `.name`, which would otherwise hit the bare generic (type-param fields
	// have no concrete size).
	node.return_type = resolve_mono_type(node.return_type, status);
	// An enum-with-data return also uses sret: a plain x0 return hands the
	// caller a pointer into THIS function's frame, which dies at `ret` —
	// any intervening call on the caller's side would clobber the bytes.
	const return_struct =
		!node.return_type.is_view &&
		!node.return_type.is_array &&
		(!!status.structs.find(
			(s) => s.name === node.return_type.name && !s.is_simple_type && !s.is_class,
		) ||
			get_enum_sret_size(node.return_type.name, status) !== undefined);
	if (return_struct) {
		status.struct_return_buffer = "x8";
	}
	status.function_return_type = node.return_type;
	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const has_body = node.has_body && node.statements.length > 0;

	const callee_saved = ["x19", "x20", "x21", "x22"];
	const callee_map = new Map<string, string>();
	let callee_idx = 0;

	status.code += `.p2align 2\n`;
	if (node.name === "main") {
		status.code += `.globl _main\n`;
	}
	// Make user functions visible to the companion C file (spawn trampolines
	// call user functions defined in assembly). On macOS, C symbols have a
	// leading _ prefix, so we define both the bare label (for bl references
	// from other assembly) and the _-prefixed label (for C linkage). A
	// nested function emits under its uniquified label_name (siblings
	// sharing a source name, or mono clones of one generic parent, must not
	// collide); top-level functions keep their own name.
	const label_name = emission_label(node);
	if (node.name === "main") {
		status.code += `_main:\n`;
	} else {
		status.code += `.globl ${label_name}\n`;
		status.code += `${label_name}:\n`;
		if (status.platform !== "windows") {
			status.code += `.globl _${label_name}\n`;
			status.code += `_${label_name} = ${label_name}\n`;
		}
	}
	status.code += `stp x29, x30, [sp, #-16]!\n`;

	const is_main_with_init =
		node.name === "main" &&
		has_body &&
		node.params.length > 0 &&
		node.params[0].type.name === "Init";
	let init_struct_size = 0;
	if (is_main_with_init) {
		const vt_size = 8;
		const argc_offset = vt_size;
		const args_offset = vt_size + 8;
		const args_count = 16;
		// `is_tty` (bool, 1 byte) is the last Init field, after the fat
		// `string[16] args` array (8-byte length prefix + 16×16-byte
		// {ptr, len} elements = 264). Resolve its offset and the total struct
		// size from the layout helpers so this stays correct if the struct
		// changes, and round the frame up to 16 for AAPCS64 alignment.
		const is_tty_offset = get_field_offset("Init", "is_tty", status) || args_offset + 264;
		init_struct_size = Math.ceil((get_struct_size("Init", status) || is_tty_offset + 1) / 16) * 16;
		status.code += `sub sp, sp, #${init_struct_size}\n`;
		status.code += `str x0, [sp, #${argc_offset}]\n`;
		status.code += `str x1, [sp, #${args_offset}]\n`;
		status.code += `mov x20, x1\n`;
		status.code += `mov x2, #0\n`;
		const loop_label = `.Linit_loop_${label_counter}`;
		const end_label = `.Linit_end_${label_counter}`;
		label_counter++;
		status.code += `${loop_label}:\n`;
		status.code += `ldr x3, [sp, #${argc_offset}]\n`;
		status.code += `cmp x2, x3\n`;
		status.code += `b.ge ${end_label}\n`;
		status.code += `cmp x2, #${args_count}\n`;
		status.code += `b.ge ${end_label}\n`;
		// Copy argv[i] into the fat-string element {ptr, len} — the len half
		// is strlen(argv[i]) (argv strings are NUL-terminated C strings).
		// i (x2) and argv[i] are spilled across the strlen call; x20 (argv)
		// is callee-saved and survives it.
		status.code += `ldr x0, [x20, x2, lsl #3]\n`;
		status.code += `stp x2, x0, [sp, #-16]!\n`;
		status.code += `bl _strlen\n`;
		status.code += `ldp x2, x1, [sp], #16\n`;
		status.code += `mov x4, #${args_offset}\n`;
		status.code += `add x4, x4, x2, lsl #4\n`;
		status.code += `str x1, [sp, x4]\n`;
		status.code += `add x4, x4, #8\n`;
		status.code += `str x0, [sp, x4]\n`;
		status.code += `add x2, x2, #1\n`;
		status.code += `b ${loop_label}\n`;
		status.code += `${end_label}:\n`;
		// `init.is_tty = isatty(1)` — whether stdout is a terminal, for
		// renderer selection. Done after the argv loop (x20/x2/x3 are dead
		// here) and before any callee-saved param regs are live.
		status.code += `mov x0, #1\n`;
		status.code += `bl _isatty\n`;
		status.code += `strb w0, [sp, #${is_tty_offset}]\n`;
		status.code += `mov x0, sp\n`;
	}

	if (has_body) {
		// Track the AAPCS64 register slot index (variadic = 2 slots, array = 1,
		// everything else = 1). The previous loop used the raw params index,
		// which under-counted in the presence of a variadic param and so read
		// the wrong register for a struct param that followed one.
		let first_pass_slot = 0;
		for (let i = 0; i < node.params.length; i++) {
			const param = node.params[i];
			// Array-typed params (including variadic) hold a pointer, not a
			// struct value — don't classify them as struct params.
			if (param.is_variadic) {
				first_pass_slot += 2;
				continue;
			}
			if (param.type.is_array) {
				first_pass_slot += 1;
				continue;
			}
			// A fat `string` or `view T` param arrives as a (ptr, len)
			// REGISTER PAIR — two AAPCS64 slots. It is not a by-address
			// struct param (excluded from the callee-saved pool; spilled to
			// a 16-byte stack slot in the second pass below).
			if (param.type.is_view || param.type.name === "string") {
				first_pass_slot += 2;
				continue;
			}
			// A class param is a reference type (a heap pointer), but the body
			// accesses it as a pointer VALUE — so it still belongs in the
			// callee-saved register path (saved like a struct param and read
			// back as a value). Excluding it here would spill it to a stack
			// slot that the method-receiver load treats as a by-address struct
			// (address-of instead of load), corrupting class params. See
			// trait_dispatch / class-move / memory-var-class-param tests.
			const is_struct_type = !!status.structs.find(
				(s) => s.name === param.type.name && !s.is_simple_type,
			);
			// A trait-typed param arrives as a pointer to the concrete struct
			// (whose vtable lives at offset 0), so save it in a callee-saved
			// register like a struct param — trait-typed dispatch reads the
			// receiver pointer from there.
			const is_trait_type = !!status.traits.find((t) => t.name === param.type.name);
			const is_enum_with_data = !!status.enums.find(
				(e) => e.name === param.type.name && e.has_associated_data,
			);
			if (
				(is_struct_type || is_trait_type || is_enum_with_data) &&
				callee_idx < callee_saved.length
			) {
				const saved_reg = callee_saved[callee_idx++];
				status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				if (first_pass_slot < NUM_REG_ARGS) {
					status.code += `mov ${saved_reg}, ${param_regs[first_pass_slot]}\n`;
				} else {
					// Overflow: this arg arrived in the caller's outgoing stack
					// area. After the push above, sp = caller_sp - 16 -
					// 16*callee_idx, so the k-th stack arg (slot 8+k) lives at
					// [sp, #(16 + 16*callee_idx + k*8)].
					const k = first_pass_slot - NUM_REG_ARGS;
					status.code += `ldr ${saved_reg}, [sp, #${16 + 16 * callee_idx + k * 8}]\n`;
				}
				callee_map.set(param.name, saved_reg);
			}
			first_pass_slot++;
		}
	}

	const stack_placeholder = `STACK_SIZE_${label_name}`;
	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	if (return_struct) {
		const return_buffer_stack_offset = allocate_stack_space(status, 8, 8);
		status.code += `str x8, [x29, #${return_buffer_stack_offset}]\n`;
		status.return_buffer_stack_offset = return_buffer_stack_offset;
	}

	// Save the enclosing function's param-tracking sets so a nested function
	// build doesn't leak its params into the enclosing scope's statement
	// phase (e.g. a nested `ref Nursery pool` colliding with a same-named
	// local in the enclosing body). Restored after the body is built.
	const old_function_param_regs = status.function_param_regs;
	const old_function_param_vars = status.function_param_vars;
	const old_function_array_params = status.function_array_params;
	const old_function_ref_params = status.function_ref_params;
	const old_ref_class_slots = status.ref_class_slots;
	const old_struct_param_slots = status.function_struct_param_slots;
	const old_function_param_types = status.function_param_types;
	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_array_params = new Set();
	status.function_ref_params = new Set();
	status.ref_class_slots = new Map();
	status.function_struct_param_slots = new Set();
	status.function_param_types = new Map();
	const old_variadic_params_aarch64 = status.function_variadic_params;
	const old_view_params = status.function_view_params;
	status.function_variadic_params = new Set();
	status.function_view_params = new Set();
	status.moved_class_params = new Map();

	// Save mov'd class param values for cleanup at return
	let moved_param_save_slots: Map<
		string,
		{
			offset: number;
			type_name: string;
			type_args?: Type[];
			is_nullable?: boolean;
		}
	> = new Map();

	// Whole-function register allocation (phase 4): reserve callee-saved
	// registers for the body's hottest scalar locals AND params before
	// building the prologue's param spills, so a promoted param initializes
	// its register directly instead of spilling (and every later access is
	// register-resident with no loop brackets). Seeding
	// `callee_saved_regs_used` first also keeps loop promotion and Buffer
	// data-pointer caches off these registers. Snapshot the enclosing state so
	// a nested function build (a `func` statement inside this body) can't leak
	// its own bindings into ours — or clobber our claimed-register set.
	const old_register_allocations = status.register_allocations;
	const old_nir_site_allocs = status.nir_site_allocs;
	const old_callee_saved_regs = status.callee_saved_regs_used;
	const old_nir_caller_claimed = status.nir_caller_saved_claimed;
	// ONE canonical lowering per function (phase 4 stage 2): the NIR drives
	// both the promotion planner here and the emission path below via
	// `status.nir_emit_ctx`.
	const nir: NirFunction | undefined = has_body ? lower_function(node) : undefined;
	if (nir && nir.unknown_kinds.size > 0) {
		// Lowering is total over the checked AST — a residual kind is a
		// compiler bug, not user error. Fail loudly instead of silently
		// re-walking the AST (the whole-function fallback is retired).
		throw new Error(
			`NIR lowering gap in ${node.name || label_name}: ${[...nir.unknown_kinds].join(", ")}`,
		);
	}
	// Tranche M (ASM_PLAN_3): loop value numbering runs BETWEEN lowering and
	// the register plan, so the allocator sees the hoisted temps' traffic
	// (the plan computed here is the plan the emitter below will honor —
	// both run the same deterministic rewrite). The AST splices ride the
	// body build and are undone right after it (the AST is shared with the
	// C backend and re-lowered per inline expansion).
	let vn: VnPlan | undefined;
	let plan_nir: NirFunction | undefined = nir;
	if (nir) {
		vn = value_number_loops(nir.body, node.statements, status, true);
		if (vn.stmts !== nir.body) plan_nir = { ...nir, body: vn.stmts as NirStmt[] };
	}
	// Tranche G stage 1 (ASM_PLAN_2): when the NIR-level allocator is
	// enabled it replaces the legacy pass entirely — statement-granularity
	// liveness, interference sharing, caller-saved ext pool for
	// call-free-contained int ranges. Off (default) keeps the legacy
	// expressions verbatim: byte-identical output.
	let fn_allocs: Map<string, string> | undefined;
	let fn_callee_saved: Set<string> | undefined;
	if (nir) {
		if (nir_regalloc_enabled()) {
			const plan = plan_nir_registers(node, plan_nir!);
			// Stage 3: split plain-name bindings (live from function entry —
			// the prologue initializes params into them) from decl-site
			// bindings (the emitter binds those at each declare site, so
			// same-named locals in sibling scopes never fight over one map
			// entry). allocs carries both for the invariant tests; only the
			// plain half installs here.
			const plain = new Map<string, string>();
			const site_table = new Map<string, { name: string; reg: string }>();
			for (const [key, reg] of plan.allocs) {
				const site = plan.sites.get(key);
				if (site) site_table.set(key, site);
				else plain.set(key, reg);
			}
			fn_allocs = plain;
			status.nir_site_allocs = site_table.size > 0 ? site_table : undefined;
			// Always defined under the new pass (possibly empty): the
			// caller-saved ext regs must never ride the prologue's save set.
			fn_callee_saved = plan.callee_saved;
			// Interference facts so loop promotion shares function-claimed
			// registers when its candidates provably never overlap them.
			status.nir_alloc_shared = {
				adj: plan.adj,
				pinned: plan.pinned,
				source_keys: plan.source_keys,
			};
			// Caller-saved ext claims ride a set that SURVIVES inline
			// expansions (which clear register_allocations), so loop
			// promotion inside an inlined body can't reclaim one while a
			// variable is live across the expansion.
			status.nir_caller_saved_claimed = new Set(
				[...plan.allocs.values()].filter((r) => /^x1[2-5]$/.test(r)),
			);
			if (status.nir_caller_saved_claimed.size === 0) {
				status.nir_caller_saved_claimed = undefined;
			}
		} else {
			fn_allocs = plan_function_promotions(node, plan_nir!);
			// Legacy pass has no decl-site table — clear any enclosing
			// function's so this body's declare keys can't resolve against it.
			status.nir_site_allocs = undefined;
		}
	} else {
		// No body (no NIR): nothing of this function can bind; drop any
		// enclosing table for the duration of the build.
		status.nir_site_allocs = undefined;
	}
	status.register_allocations = fn_allocs && fn_allocs.size > 0 ? fn_allocs : undefined;
	status.callee_saved_regs_used =
		fn_callee_saved !== undefined
			? fn_callee_saved.size > 0
				? fn_callee_saved
				: undefined
			: fn_allocs && fn_allocs.size > 0
				? new Set(fn_allocs.values())
				: undefined;
	if (has_body) {
		let param_idx = 0;
		for (let i = 0; i < node.params.length; i++) {
			const param = node.params[i];
			// Recorded before the per-shape branches below (view/string spill
			// paths `continue` early) so loop promotion can resolve ANY param's
			// type — a float param must not fall into the ""→int pool default.
			status.function_param_types!.set(param.name, param.type);

			if (param.is_variadic) {
				status.function_variadic_params!.add(param.name);
				// Hidden _name_len param (takes a register slot before the array ptr)
				const len_offset = allocate_stack_space(status, 8, 8);
				status.stack_offsets!.set(`_${param.name}_len`, len_offset);
				if (param_idx < NUM_REG_ARGS) {
					const len_reg = param_regs[param_idx];
					status.code += `str ${len_reg}, [x29, #${len_offset}]\n`;
				} else {
					const k = param_idx - NUM_REG_ARGS;
					status.code += `ldr x9, [x29, #${overflow_placeholder(label_name, k)}]\n`;
					status.code += `str x9, [x29, #${len_offset}]\n`;
				}
				param_idx++;
			}

			// A `view T` param is a (ptr, len) pair: spill BOTH halves from
			// their two register slots (or the caller's outgoing stack area)
			// into a 16-byte local so `.length` / `.at` / forwarding read the
			// correct pair. Consumes two param register slots — matching the
			// call site's pair passing — so skip the generic single-slot
			// spill and the trailing param_idx++.
			if (param.type.is_view) {
				const offset = allocate_stack_space(status, 16, 16);
				status.stack_offsets!.set(param.name, offset);
				status.function_view_params!.add(param.name);
				// Each half comes from its own register slot, or from the
				// caller's outgoing stack area when its slot is past x7 (the
				// pair can straddle the boundary: ptr in x7, len at [sp]).
				for (const half of [0, 1] as const) {
					const p_slot = param_idx + half;
					if (p_slot < NUM_REG_ARGS) {
						status.code += `str ${param_regs[p_slot]}, [x29, #${offset + half * 8}]\n`;
					} else {
						const k = p_slot - NUM_REG_ARGS;
						status.code += `ldr x9, [x29, #${overflow_placeholder(label_name, k)}]\n`;
						status.code += `str x9, [x29, #${offset + half * 8}]\n`;
					}
				}
				param_idx += 2;
				continue;
			}

			// A fat `string` param is a (ptr, len) pair: spill BOTH halves
			// from their two register slots (or the caller's outgoing stack
			// area) into a 16-byte local — identical shape to `view T`.
			// Consumes two param register slots, so skip the generic
			// single-slot spill and the trailing param_idx++.
			// (`ref string` params are excluded — they arrive as ONE slot
			// holding &caller-storage; param.is_ref only covers `ref self`,
			// so test the TYPE's ref flag. String ARRAY params
			// (`Array<string>` / `string[]`, also typed name="string") are
			// excluded too — they arrive as ONE buffer-pointer slot.)
			if (
				param.type.name === "string" &&
				!param.type.is_view &&
				!param.type.is_ref &&
				!param.type.is_array
			) {
				const offset = allocate_stack_space(status, 16, 16);
				status.stack_offsets!.set(param.name, offset);
				for (const half of [0, 1] as const) {
					const p_slot = param_idx + half;
					if (p_slot < NUM_REG_ARGS) {
						status.code += `str ${param_regs[p_slot]}, [x29, #${offset + half * 8}]\n`;
					} else {
						const k = p_slot - NUM_REG_ARGS;
						status.code += `ldr x9, [x29, #${overflow_placeholder(label_name, k)}]\n`;
						status.code += `str x9, [x29, #${offset + half * 8}]\n`;
					}
				}
				param_idx += 2;
				if (param.declaration === "var") {
					status.function_param_vars.add(param.name);
				}
				continue;
			}

			if (callee_map.has(param.name)) {
				const reg = callee_map.get(param.name)!;
				status.function_param_regs.set(param.name, reg);
				// A `ref` class param's register currently holds the ADDRESS of the
				// caller's pointer slot (the call site passes &slot so the callee
				// can reassign it). Field access expects the register to hold the
				// instance, so dereference once — and save &slot separately (in a
				// dedicated slot) for the reassignment write-back path.
				if (param.type.is_ref) {
					const is_class = !!status.structs.find((s) => s.name === param.type.name && s.is_class);
					if (is_class) {
						const ref_slot = allocate_stack_space(status, 8, 8);
						status.code += `str ${reg}, [x29, #${ref_slot}]\n`;
						status.code += `ldr ${reg}, [${reg}]\n`;
						status.ref_class_slots?.set(param.name, ref_slot);
					}
				}
			} else {
				// A `ref T` param receives an 8-byte pointer to the caller's
				// storage regardless of T's size, so the local slot must always
				// be 8 bytes (spilling `ref bool` as `strb` truncates the
				// address). The element width only matters at the dereference.
				const is_ref = param.type.is_ref;
				const size = is_ref ? 8 : aarch64_size(param.type.name);
				const offset = allocate_stack_space(status, size, is_ref ? 8 : size);
				status.stack_offsets!.set(param.name, offset);
				// A struct/trait/enum-with-data/class param that missed the
				// callee-saved register pool still follows the by-address
				// convention: its slot holds the POINTER to the caller's
				// struct, not the inline value. Record it so emit_var_address
				// loads the pointer instead of taking the slot's address (a
				// double indirection that corrupts every consumer — forwarding,
				// field access, method calls). `ref` params are excluded: the
				// function_ref_params / is_local_ref_var mechanism already
				// dereferences their slots, and array params have their own
				// pointer conventions.
				if (!is_ref && !param.type.is_array && !param.is_variadic) {
					const spilled_is_structish =
						!!status.structs.find((s) => s.name === param.type.name && !s.is_simple_type) ||
						!!status.traits.find((t) => t.name === param.type.name) ||
						!!status.enums.find((e) => e.name === param.type.name && e.has_associated_data);
					if (spilled_is_structish) {
						status.function_struct_param_slots!.add(param.name);
					}
				}
				// Whole-function-promoted param: initialize the callee-saved
				// register instead of (or in addition to) spilling. 8-byte params
				// (int64/uint64, every float — floats ride an x param register as
				// raw bits) move/load straight into the register and SKIP the
				// spill: the home slot stays dead until an eventual
				// emit_var_address flush. Sub-word params keep the spill and add a
				// width-aware load, so the register holds exactly the zero-extended
				// value a body read of the slot would produce.
				const promoted_reg = status.register_allocations?.get(param.name);
				const param_is_float = ALL_FLOAT_TYPES.includes(param.type.name);
				if (param_idx < NUM_REG_ARGS) {
					const reg = param_regs[param_idx];
					if (promoted_reg && size === 8) {
						if (param_is_float) {
							status.code += `fmov ${promoted_reg}, ${reg}\n`;
						} else {
							status.code += `mov ${promoted_reg}, ${reg}\n`;
						}
					} else {
						if (size === 1) {
							status.code += `strb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
						} else if (size === 2) {
							status.code += `strh ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
						} else if (size === 4) {
							status.code += `str ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
						} else {
							status.code += `str ${reg}, [x29, #${offset}]\n`;
						}
						if (promoted_reg) {
							emit_promoted_load(status, promoted_reg, offset, param.type.name);
						}
					}
				} else {
					// Overflow: arg arrived on the caller's stack. Load via x9
					// (caller-saved scratch — free at the prologue) and store
					// with the param's declared width so the local slot matches
					// what the register path would have produced.
					const k = param_idx - NUM_REG_ARGS;
					if (promoted_reg && size === 8) {
						status.code += `ldr ${promoted_reg}, [x29, #${overflow_placeholder(label_name, k)}]\n`;
					} else {
						status.code += `ldr x9, [x29, #${overflow_placeholder(label_name, k)}]\n`;
						if (size === 1) {
							status.code += `strb w9, [x29, #${offset}]\n`;
						} else if (size === 2) {
							status.code += `strh w9, [x29, #${offset}]\n`;
						} else if (size === 4) {
							status.code += `str w9, [x29, #${offset}]\n`;
						} else {
							status.code += `str x9, [x29, #${offset}]\n`;
						}
						if (promoted_reg) {
							emit_promoted_load(status, promoted_reg, offset, param.type.name);
						}
					}
				}
			}
			param_idx++;

			if (param.declaration === "var") {
				status.function_param_vars.add(param.name);
			}
			if (param.type.is_array) {
				// An `Array<T>` parameter (parse-rewritten to `{name: T, is_array:
				// true}`) is a heap `struct Array_<T>*` pointer when the mono
				// `Array_<T>` struct exists (i.e. the type was instantiated — e.g.
				// by an `Array<T>.with(...)` call) — register it in
				// `heap_array_vars` so `.length`/`.at`/`.set` and for-loop
				// iteration use the struct layout (length at [ptr+0], data at
				// [ptr+8]). When the struct does NOT exist (the param is only used
				// for raw `for n of` iteration with a stack-array arg), keep the
				// raw `function_array_params` data-pointer layout. This mirrors
				// the C backend's build_parameter_node promotion, so the body and
				// the signature stay consistent. Variadic `...T` params are
				// excluded by the `is_variadic` guard.
				const arr_struct = !param.is_variadic ? array_struct_name(param.type, status) : undefined;
				if (arr_struct) {
					if (!status.heap_array_vars) status.heap_array_vars = new Set();
					status.heap_array_vars.add(param.name);
				} else {
					status.function_array_params!.add(param.name);
				}
			}
			// A `ref Array<T>` param is a single `struct Array_<T>*` (mutation is
			// in-place via `.set`, not write-back through a double pointer), so it
			// must NOT be registered in `function_ref_params` — that set steers the
			// access/value paths to treat the slot as a pointer-to-pointer
			// (`is_local_ref_var`), which would dereference the heap pointer as if
			// it were an address. Skip the ref registration when the param was
			// already claimed as a heap-array struct above.
			if (param.type.is_ref && !status.heap_array_vars?.has(param.name)) {
				status.function_ref_params!.add(param.name);
			}
		}
	}

	const moved_before = new Set(status.moved ?? []);

	// Track mov'd class params for cleanup at return. This runs regardless of
	// whether the function has a body: a `mov Box x` param is owned by the
	// callee and must be reclaimed (with its #destroy + field destroys) even
	// when the body is empty. The incoming value is saved from whichever
	// register holds it at entry — the callee-saved register assigned during
	// the prologue, or the incoming param register when none was assigned.
	let pidx = 0;
	for (let i = 0; i < node.params.length; i++) {
		const param = node.params[i];
		if (param.is_variadic) pidx += 2;
		else if (param.type.is_array) pidx += 1;
		// Fat strings and views consume two AAPCS slots (pair ABI).
		else if (param.type.name === "string" || param.type.is_view) pidx += 2;
		if (param.is_moved) {
			const is_class = !!status.structs.find((s) => s.name === param.type.name && s.is_class);
			if (is_class) {
				const reg = callee_map.get(param.name) ?? param_regs[pidx];
				status.moved_class_params!.set(param.name, reg);
				const save_offset = allocate_stack_space(status, 8);
				status.code += `str ${reg}, [x29, #${save_offset}]\n`;
				moved_param_save_slots.set(param.name, {
					offset: save_offset,
					type_name: param.type.name,
					type_args: param.type.type_args,
					is_nullable: param.type.is_nullable,
				});
			}
		}
		pidx++;
	}

	const old_force_heap = status.force_heap_strings;
	status.force_heap_strings = scan_force_heap_strings(node.statements, status.structs);

	// Each function body starts with a fresh Buffer data-pointer cache so a
	// cache entry established while building an earlier function can't leak in
	// and produce a bogus "hit" that skips the data-pointer load.
	const old_buffer_data_cache = status.buffer_data_cache;
	status.buffer_data_cache = undefined;
	const old_array_ptr_cache = status.array_ptr_cache;
	status.array_ptr_cache = undefined;

	// NIR-driven emission: the ctx is published for EVERY function body (the
	// whole-function AST fallback is retired — emission dispatches through
	// emit_stmt_from_nir). `nir_emission_enabled()` is the per-statement
	// delegation toggle used by the byte-identity A/B tests. Restored after
	// the body so a nested function build hands ours back. Stage 4 (see
	// forward.ts) rewrites single-use forwards against the plan installed
	// above and reports write-only flag names; the prepared list (a fresh
	// spine when anything rewrote) is what gets published, not nir.body —
	// the shared lowering object stays untouched.
	const old_nir_ctx = status.nir_emit_ctx;
	if (plan_nir && nir_emission_enabled()) {
		const prepared = prepare_nir_forwarding(plan_nir.body, status, vn?.host_stmts);
		// Merge the value-numbering use sites with the forwarder's: the two
		// pass gates keep any single host from carrying overlapping splices,
		// so plain concatenation is enough.
		const use_sites = new Map(prepared.use_sites);
		if (vn && vn.use_sites.size > 0) {
			for (const [host, use] of vn.use_sites) {
				const existing = use_sites.get(host);
				if (existing) existing.splices.push(...use.splices);
				else use_sites.set(host, use);
			}
		}
		status.nir_emit_ctx = {
			stmts: prepared.stmts,
			ast: node.statements,
			write_only: prepared.write_only,
			use_sites,
			forward_defs: prepared.forward_defs,
		};
	} else {
		status.nir_emit_ctx = undefined;
	}

	try {
		build_block_node(node, status);
	} finally {
		status.nir_emit_ctx = old_nir_ctx;
		vn?.undo();
	}

	status.buffer_data_cache = old_buffer_data_cache;
	status.array_ptr_cache = old_array_ptr_cache;
	status.force_heap_strings = old_force_heap;

	const loop_regs_used = status.callee_saved_regs_used
		? [...status.callee_saved_regs_used].sort()
		: [];
	// Restore the ENCLOSING function's state (previously cleared to undefined,
	// which dropped an outer function's claimed registers when a nested
	// function was built mid-body — its prologue saves went missing).
	status.callee_saved_regs_used = old_callee_saved_regs;
	status.register_allocations = old_register_allocations;
	status.nir_site_allocs = old_nir_site_allocs;
	status.nir_caller_saved_claimed = old_nir_caller_claimed;
	status.nir_alloc_shared = undefined;

	if (loop_regs_used.length > 0 && has_body) {
		const func_label = `${node.name === "main" ? "_" : ""}${label_name}:`;
		const func_start = status.code.indexOf(func_label);
		const search_for = `sub sp, sp, #${stack_placeholder}`;
		const after_prologue = func_start !== -1 ? status.code.indexOf(search_for, func_start) : -1;
		if (after_prologue !== -1) {
			let saves = "";
			for (const reg of loop_regs_used) {
				saves += `str ${reg}, [sp, #-16]!\n`;
			}
			status.code =
				status.code.slice(0, after_prologue) + saves + status.code.slice(after_prologue);
		}
	}

	const moved_after = status.moved;
	const heap_after = status.heap_strings;
	if (moved_after) {
		for (const name of moved_after) {
			if (moved_before.has(name)) continue;
			if (heap_after?.has(name)) {
				if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
				status.heap_returning_functions.add(label_name);
				break;
			}
		}
	}
	const return_is_class = status.structs.some(
		(s) => s.name === node.return_type.name && s.is_class,
	);
	if (return_is_class) {
		if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
		status.heap_returning_functions.add(label_name);
	}

	status.code += `${return_label}:\n`;
	if (node.name === "main") {
		// In audit mode, call nomen_audit_check at main exit (linked from
		// audit_runtime.c). If the pool was used (spawn was emitted), shut
		// it down first so workers are joined and freed — otherwise the
		// pool's atexit handler runs after audit_check and the workers
		// array shows up as a false-positive leak. (Run before `mov x0, #0`
		// so the void audit_check doesn't clobber main's return value.)
		if (status.audit) {
			if (status.file_scope_c?.includes("__nomen_pool_submit")) {
				status.code += `bl ___nomen_pool_shutdown\n`;
			}
			status.code += `bl _nomen_audit_check\n`;
		}
		status.code += `mov x0, #0\n`;
	}

	// Reclaim mov'd class params: run #destroy + field destroys (which free
	// owned class fields) then free the instance itself. Skip params that were
	// moved out within the body. When the function returns a class, also skip a
	// param whose value is the return value — it is handed back to the caller.
	// The return value lives in x0 and the destroy/free calls clobber it, so
	// for ANY non-void return it is spilled across the reclaim and reloaded
	// afterwards (the equality guard is only meaningful for class returns,
	// where a returned instance may be the param itself).
	const moved_set = status.moved;
	if (moved_param_save_slots.size > 0 && node.name !== "main") {
		const need_guard = return_is_class;
		const need_save = !!node.return_type?.name;
		let return_save: number | undefined;
		if (need_guard || need_save) {
			return_save = allocate_stack_space(status, 8);
			status.code += `str x0, [x29, #${return_save}]\n`;
		}
		for (const [name, info] of moved_param_save_slots) {
			if (moved_set?.has(name)) continue;
			// A param whose ownership escapes into an outliving value (stored
			// into a container, forwarded, returned) is not the callee's to
			// free — mirrors the C backend's registration gate.
			if (moved_param_is_consumed(node, name)) continue;
			if (need_guard) {
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
			if (need_guard) {
				status.code += `${keep_prefix}_${name}:\n`;
			}
		}
		if (need_guard || need_save) {
			status.code += `ldr x0, [x29, #${return_save!}]\n`;
		}
	}

	const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
	status.code = status.code.replace(
		`sub sp, sp, #${stack_placeholder}`,
		total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
	);
	// Now that the local frame size is known, resolve the per-overflow-arg
	// placeholders emitted in the second prologue pass to their concrete x29
	// offsets. Each `str xN, [sp, #-16]!` between `stp x29, x30, [sp, #-16]!`
	// and `sub sp, sp, #STACK_SIZE` pushes sp 16 bytes further below the
	// caller's outgoing stack args, so the offset from x29 to slot 8+k grows
	// by 16 per push: 16 + 16*(callee_idx + loop_regs_used.length) +
	// total_stack + k*8. (loop_regs_used saves are inserted just above
	// `sub sp, sp, #STACK_SIZE` after the body is built, but they sit in the
	// emitted instruction stream between the first-pass saves and the sub, so
	// they count here.)
	if (total_stack > 0) {
		status.code += `add sp, sp, #${total_stack}\n`;
	}
	status.code = patch_overflow_placeholders(
		status.code,
		label_name,
		callee_idx + loop_regs_used.length,
		total_stack,
	);

	for (let i = loop_regs_used.length - 1; i >= 0; i--) {
		status.code += `ldr ${loop_regs_used[i]}, [sp], #16\n`;
	}

	for (let ci = callee_idx - 1; ci >= 0; ci--) {
		status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
	}

	if (init_struct_size > 0) {
		status.code += `add sp, sp, #${init_struct_size}\n`;
	}

	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	status.code = peephole_optimize(status.code);

	if (is_nested) {
		if (status.function_data) {
			status.code += status.function_data;
			status.function_data = undefined;
		}
		if (!status.nested_functions) status.nested_functions = "";
		status.nested_functions += status.code;
		status.code = old_code!;
	}

	if (status.function_data) {
		status.code += status.function_data;
		status.function_data = undefined;
	}
	if (status.nested_functions && !is_nested) {
		status.code += status.nested_functions;
		status.nested_functions = undefined;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.moved = old_moved;
	status.heap_strings = old_heap_strings;
	status.heap_string_arrays = old_heap_string_arrays;
	status.heap_owned_string_arrays = old_heap_owned_string_arrays;
	status.heap_class_arrays = old_heap_class_arrays;
	status.heap_array_vars = old_heap_array_vars;
	status.current_function_name = old_function_name;
	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
	status.function_param_regs = old_function_param_regs;
	status.function_param_vars = old_function_param_vars;
	status.function_array_params = old_function_array_params;
	status.function_ref_params = old_function_ref_params;
	status.ref_class_slots = old_ref_class_slots;
	status.function_struct_param_slots = old_struct_param_slots;
	status.function_param_types = old_function_param_types;
	status.function_variadic_params = old_variadic_params_aarch64;
	status.function_view_params = old_view_params;
	status.function_return_label = old_return_label;
	status.struct_return_buffer = undefined;
	status.return_buffer_stack_offset = undefined;
	status.function_return_type = undefined;
}
