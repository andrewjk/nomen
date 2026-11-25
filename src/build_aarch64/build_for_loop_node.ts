import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import type { NirStmt } from "../nir/nir.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_node from "./build_node.ts";
import { tree_is_call_free } from "./build_operation_node.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { emit_neon_vector_loop } from "./neon_emit.ts";
import type { NeonPlan } from "./neon_plan.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free } from "./utils/audit.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { promote_loop_locals, type PromotedVar } from "./utils/loop_promotion.ts";
import {
	allocate_stack_space,
	emit_promoted_store,
	emit_var_address,
	emit_var_load,
	emit_var_store,
} from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_for_loop_node(
	node: ForLoopNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "for" },
	vector?: NeonPlan | null,
) {
	const old_scoped_declarations = enter_scope_frame(status);

	const label = label_counter++;
	const item_name = node.item.value;
	const start_label = `.for_${label}`;
	const end_label = `.end_${label}`;
	const increment_label = `.for_inc_${label}`;
	const continue_label = node.update ? `.for_update_${label}` : increment_label;

	status.loop_labels = status.loop_labels || [];
	const cleanup_depth = status.heap_cleanup_stack?.length ?? 0;
	status.loop_labels.push({
		start: continue_label,
		end: end_label,
		cleanup_depth,
	});
	if (!status.loop_writebacks) status.loop_writebacks = [];
	status.loop_writebacks.push(undefined);

	if (status.function_return_label) {
		const item_offset = allocate_stack_space(status, 8);
		status.stack_offsets!.set(item_name, item_offset);
	}

	// `for ref x of arr` is a TRUE ELEMENT BORROW: the item is an 8-byte
	// pointer to the array slot (the `ref T` local shape — body accesses
	// deref through `function_ref_params`, and stores land in the slot
	// immediately). Registered BEFORE `promote_loop_locals`, whose
	// aliasing-aware exclusions must see the borrow — promoting the item
	// into a scratch register would break write-through semantics — and any
	// stale promotion entry is dropped for the same reason (the item must
	// resolve via its pointer slot). No write-back exists: arrays are
	// fixed-length, so the slot address is stable for the loop's lifetime.
	// (The item slot above holds the pointer for array loops, and the scalar
	// value for range/enumerable loops — same 8-byte width.)
	let saved_was_ref_param = false;
	let saved_item_alloc: string | undefined;
	let saved_item_param_type: import("../nodes/Type.ts").default | undefined;
	let saved_in_borrow_set = false;
	if (node.item_is_ref) {
		if (!status.function_ref_params) status.function_ref_params = new Set();
		saved_was_ref_param = status.function_ref_params.has(item_name);
		status.function_ref_params.add(item_name);
		saved_item_alloc = status.register_allocations?.get(item_name);
		if (saved_item_alloc !== undefined) {
			status.register_allocations!.delete(item_name);
		}
	}

	const promoted: PromotedVar[] = [];
	const saved_reg_allocs = status.register_allocations
		? new Map(status.register_allocations)
		: undefined;
	// Declare-slot pre-allocation (tranche D addendum): promotion records
	// pre-allocated slots for the body's declares; the set lives exactly for
	// this loop's body build (the declare sites consume it) and is restored
	// after so a later declare of the same name can't alias this loop's slot.
	const saved_preallocated = status.preallocated_decl_slots;
	// Field-pair SLP state (ASM_PLAN_4): visible to the body, restored
	// at exit.
	const saved_slp_hints = status.slp_pair_hints;
	const saved_slp_vregs = status.slp_pair_vregs;
	const saved_buffer_cache = status.buffer_data_cache;
	status.buffer_data_cache = undefined;
	const saved_fold_cache = status.buffer_fold_cache;
	status.buffer_fold_cache = undefined;
	const saved_array_cache = status.array_ptr_cache;
	status.array_ptr_cache = undefined;

	if (status.function_return_label && node.statements.length > 0) {
		const call_free = nir
			? nir.body.every((st) => tree_is_call_free(st.node, status, new Set()))
			: node.statements.every((st) => tree_is_call_free(st, status, new Set()));
		promoted.push(
			...promote_loop_locals(
				status,
				old_scoped_declarations,
				{
					statements: node.statements,
					update: node.update,
				},
				{
					call_free,
					// A `for ref` item is a slot borrow (its "value" is the
					// element's ADDRESS, re-stored every iteration): promoting
					// it into a register breaks write-through semantics.
					exclude: node.item_is_ref ? new Set([item_name]) : undefined,
				},
			),
		);
		// Field-pair SLP (ASM_PLAN_4): a pair hosting v8 (the NEON
		// accumulator) makes the vector plan unsafe for this loop.
		if (vector && status.slp_pair_vregs?.has("v8")) {
			vector = null;
		}
	}

	if (node.list && node.list.node_type === "range") {
		const range = node.list as RangeNode;

		if (range.left_value) {
			build_node(range.left_value, status);
		} else {
			emit_asm(status, `ldr x0, =0\n`);
		}
		emit_var_store(status, "x0", item_name, 8);

		// NEON vector loop (phase 4, tranche 2): the plan guarantees the
		// range start is 0, so emitting the vector loop after the init (and
		// its induction sync) is exact; the scalar range loop below is the
		// tail. Rides the NIR cursor only — see build_while_loop_node.
		if (vector) {
			emit_neon_vector_loop(vector, status);
		}

		emit_asm(status, `${start_label}:\n`);

		build_node(node.item, status);
		const right_is_literal = range.right_value?.node_type === "value";
		if (right_is_literal) {
			emit_asm(status, `mov x2, x0\n`);
			if (range.right_value) {
				build_node(range.right_value, status);
			} else {
				emit_asm(status, `ldr x0, =0\n`);
			}
			emit_asm(status, `cmp x2, x0\n`);
		} else {
			emit_asm(status, `str x0, [sp, #-16]!\n`);
			if (range.right_value) {
				build_node(range.right_value, status);
			} else {
				emit_asm(status, `ldr x0, =0\n`);
			}
			emit_asm(status, `mov x2, x0\n`);
			emit_asm(status, `ldr x1, [sp], #16\n`);
			emit_asm(status, `cmp x1, x2\n`);
		}
		emit_asm(status, `bge ${end_label}\n`);

		build_block_with_cursor(node, nir?.body, status);

		if (node.update) {
			emit_asm(status, `${continue_label}:\n`);
			build_node(node.update, status);
			ensure_newline(status);
		}

		emit_asm(status, `${increment_label}:\n`);
		build_node(node.item, status);
		emit_asm(status, `add x0, x0, #1\n`);
		emit_var_store(status, "x0", item_name, 8);

		emit_asm(status, `b ${start_label}\n`);
		emit_asm(status, `${end_label}:\n`);
	} else if (node.list && is_enumerable_type(node.list, status)) {
		// Enumerable type: call .length() and iterate 0..length
		const list_name = node.list.node_type === "value" ? (node.list as any).value : "_list";

		// Call container.length() to get upper bound
		emit_asm(status, `// call ${list_name}.length()\n`);
		emit_var_address(status, "x0", list_name);
		emit_asm(status, `str x0, [sp, #-16]!\n`);
		emit_asm(status, `bl ${list_name}_length\n`);
		emit_asm(status, `add sp, sp, #16\n`);
		// x0 now has length; store it in a temp
		const len_offset = allocate_stack_space(status, 8);
		emit_asm(status, `str x0, [x29, #${len_offset}]\n`);

		// Initialize index to 0
		emit_asm(status, `ldr x0, =0\n`);
		emit_var_store(status, "x0", item_name, 8);

		emit_asm(status, `${start_label}:\n`);

		// Load index
		emit_var_load(status, "x0", item_name, 8);
		// Load length
		emit_asm(status, `ldr x1, [x29, #${len_offset}]\n`);
		emit_asm(status, `cmp x0, x1\n`);
		emit_asm(status, `bge ${end_label}\n`);

		build_block_with_cursor(node, nir?.body, status);

		if (node.update) {
			emit_asm(status, `${continue_label}:\n`);
			build_node(node.update, status);
			ensure_newline(status);
		}

		emit_asm(status, `${increment_label}:\n`);
		emit_var_load(status, "x0", item_name, 8);
		emit_asm(status, `add x0, x0, #1\n`);
		emit_var_store(status, "x0", item_name, 8);

		emit_asm(status, `b ${start_label}\n`);
		emit_asm(status, `${end_label}:\n`);
	} else {
		const type = type_from_value_node(node.list);
		const length = type.length ? (type.length as any).value : "0";
		const struct_type = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
		const element_size = struct_type
			? struct_type.is_class
				? 8
				: get_struct_size(type.name, status)
			: type.name
				? aarch64_size(type.name)
				: 8;
		// A fat `string` element is a (ptr, len) pair (16 bytes) that must be
		// copied with a PAIR load into a 16-byte item slot — a single `ldr`
		// (and an 8-byte slot) dropped the length half (the loop index leaked
		// into it: `for w of string_array` yielded only one element's bytes).
		const is_fat_string_elem = type.name === "string" && !type.is_view && element_size === 16;
		const idx_name = `_idx_${item_name}`;

		if (node.item_is_ref) {
			// TRUE ELEMENT BORROW: the early 8-byte item slot holds the
			// element's ADDRESS (re-stored every iteration below). Register
			// the element type so a body reassignment resolves its width
			// (the item never passes through a declaration build, so
			// find_var_size can't see it).
			if (!status.variable_types) status.variable_types = new Map();
			status.variable_types.set(item_name, type);
		} else if ((struct_type || is_fat_string_elem) && status.function_return_label) {
			const struct_size = element_size;
			const item_offset = allocate_stack_space(status, struct_size);
			status.stack_offsets!.set(item_name, item_offset);
			if (is_fat_string_elem) {
				// Register the item's element type so an in-body reassignment
				// resolves the 16-byte pair width: the item never passes
				// through a declaration build, so find_var_size can't see it
				// (scoped_declarations is swapped out inside the body) — a
				// fat-string `x = …` then stored only the ptr half, dropping
				// the length half (at() read the stale slot len).
				if (!status.variable_types) status.variable_types = new Map();
				status.variable_types.set(item_name, type);
			}
		}

		if (status.function_return_label) {
			const idx_offset = allocate_stack_space(status, 8);
			status.stack_offsets!.set(idx_name, idx_offset);
		}

		let list_name: string;
		let materialized_list = false;
		if (node.list.node_type === "value") {
			list_name = (node.list as any).value;
		} else {
			// A non-variable list expression (a call returning `T[]`, e.g.
			// `for v of triple()`) has no name to address — the old fallback
			// emitted `adr x3, _list` (an undefined symbol). Evaluate the
			// expression ONCE into a stack slot, register the slot in
			// heap_array_vars (call-returned arrays are heap `Array_<T>`
			// buffers: length at [ptr], data past the header), and iterate the
			// slot. Materializing also keeps a bare call from re-invoking on
			// every condition check and element load. The buffer is freed
			// right after the loop's end label — break and fallthrough land
			// there (exactly one free), continue never does (the condition
			// re-reads the length), matching a scope-exit free without the
			// frame machinery.
			list_name = `_list_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
			if (!status.heap_array_vars) status.heap_array_vars = new Set();
			status.heap_array_vars.add(list_name);
			if (status.function_return_label) {
				materialized_list = true;
				const list_slot = allocate_stack_space(status, 8);
				status.stack_offsets!.set(list_name, list_slot);
				build_node(node.list, status);
				emit_var_store(status, "x0", list_name, 8);
			}
		}
		const list_type = type_from_value_node(node.list);
		const list_is_pointer =
			list_type.is_array &&
			(!!status.function_array_params?.has(list_name) || !!status.heap_array_vars?.has(list_name));

		// Dynamic-length arrays (heap-allocated via Array.with, or array params
		// whose length isn't known at compile time) need the runtime length from
		// the buffer prefix. When the type carries a compile-time length (e.g. a
		// fixed-size literal passed to a function), use that instead.
		let dyn_len_offset: number | undefined;
		if (status.function_return_label && list_is_pointer && !type.length) {
			dyn_len_offset = allocate_stack_space(status, 8);
			emit_var_load(status, "x0", list_name, 8);
			if (status.heap_array_vars?.has(list_name)) {
				emit_asm(status, `ldr x0, [x0]\n`);
			} else {
				emit_asm(status, `ldr x0, [x0, #-8]\n`);
			}
			emit_asm(status, `str x0, [x29, #${dyn_len_offset}]\n`);
		}

		emit_asm(status, `ldr x0, =0\n`);
		emit_var_store(status, "x0", idx_name, 8);

		emit_asm(status, `${start_label}:\n`);

		emit_var_load(status, "x0", idx_name, 8);
		emit_asm(status, `mov x2, x0\n`);
		if (dyn_len_offset !== undefined) {
			emit_asm(status, `ldr x0, [x29, #${dyn_len_offset}]\n`);
		} else {
			emit_asm(status, `ldr x0, =${length}\n`);
		}
		emit_asm(status, `cmp x2, x0\n`);
		emit_asm(status, `bge ${end_label}\n`);

		if (list_is_pointer) {
			emit_var_load(status, "x3", list_name, 8);
			if (status.heap_array_vars?.has(list_name)) {
				emit_asm(status, `add x3, x3, #8\n`);
			}
		} else {
			emit_var_address(status, "x3", list_name);
		}
		emit_var_load(status, "x1", idx_name, 8);
		const shift = Math.log2(element_size);
		if (Number.isInteger(shift) && shift > 0) {
			emit_asm(status, `add x0, x3, x1, lsl #${shift}\n`);
		} else {
			emit_asm(status, `mov x2, #${element_size}\n`);
			emit_asm(status, `mul x1, x1, x2\n`);
			emit_asm(status, `add x0, x3, x1\n`);
		}
		// A fat `string` element is a (ptr, len) pair (16 bytes) that must be
		// copied with a PAIR load — a single `ldr` would drop the length half
		// (the loop index leaked into it: `for w of string_array` yielded only
		// the last element's bytes).
		if (node.item_is_ref) {
			// x0 holds the element's address — store it as the item (the
			// pointer borrow), re-done every iteration so each iteration
			// borrows its own slot. A RAW store, not emit_var_store: the item
			// must never be register-folded away.
			const ptr_offset = status.stack_offsets?.get(item_name);
			if (ptr_offset !== undefined) {
				emit_asm(status, `str x0, [x29, #${ptr_offset}]\n`);
			}
			// Per-element-kind registrations for the body build. A string
			// element also joins `loop_ref_borrow_items`: its pointee is an
			// OWNED array row, so a store through the item reclaims the
			// displaced row (an ordinary `ref string` param can't — the
			// caller's ownership is unknown).
			if (!status.function_param_types) status.function_param_types = new Map();
			saved_item_param_type = status.function_param_types.get(item_name);
			status.function_param_types.set(item_name, type);
			if (type.name === "string") {
				if (!status.loop_ref_borrow_items) status.loop_ref_borrow_items = new Set();
				saved_in_borrow_set = status.loop_ref_borrow_items.has(item_name);
				status.loop_ref_borrow_items.add(item_name);
			}
		} else if (struct_type || is_fat_string_elem) {
			const item_offset = status.stack_offsets!.get(item_name);
			if (item_offset !== undefined) {
				const words = Math.ceil(element_size / 8);
				for (let w = 0; w < words; w++) {
					emit_asm(status, `ldr x1, [x0, #${w * 8}]\n`);
					emit_asm(status, `str x1, [x29, #${item_offset + w * 8}]\n`);
				}
			}
		} else {
			if (element_size === 1) {
				emit_asm(status, `ldrb w0, [x0]\n`);
			} else if (element_size === 4) {
				emit_asm(status, `ldr w0, [x0]\n`);
			} else {
				emit_asm(status, `ldr x0, [x0]\n`);
			}
			emit_var_store(status, "x0", item_name, element_size);
		}

		build_block_with_cursor(node, nir?.body, status);

		// Write the (possibly mutated) loop variable back into its array slot.
		// (Before the item's promotion entry is restored — the writeback must
		// read the slot the body just kept in sync.)
		status.loop_writebacks![status.loop_writebacks.length - 1]?.();

		if (node.item_is_ref) {
			// Restore the borrow registrations (a nested same-name loop must
			// not drop an enclosing loop's entry).
			if (saved_item_param_type === undefined) {
				status.function_param_types?.delete(item_name);
			} else {
				status.function_param_types!.set(item_name, saved_item_param_type);
			}
			if (!saved_in_borrow_set) {
				status.loop_ref_borrow_items?.delete(item_name);
			}
		}

		if (node.update) {
			emit_asm(status, `${continue_label}:\n`);
			build_node(node.update, status);
			ensure_newline(status);
		}

		emit_asm(status, `${increment_label}:\n`);
		emit_var_load(status, "x0", idx_name, 8);
		emit_asm(status, `add x0, x0, #1\n`);
		emit_var_store(status, "x0", idx_name, 8);

		emit_asm(status, `b ${start_label}\n`);
		emit_asm(status, `${end_label}:\n`);

		if (materialized_list) {
			// Free the materialized call result once the loop is done — both
			// break and fallthrough land at the end label, and continue never
			// reaches it (the loop condition still reads the buffer length).
			emit_var_load(status, "x0", list_name, 8);
			emit_free(status);
		}
	}

	for (const p of promoted) {
		// Store back with the slot's width — a full-width `str` into a
		// sub-word slot would clobber the adjacent stack bytes.
		emit_promoted_store(status, p.reg, p.offset, p.type_name);
	}

	if (saved_reg_allocs) {
		status.register_allocations = saved_reg_allocs;
	} else {
		status.register_allocations = undefined;
	}
	status.preallocated_decl_slots = saved_preallocated;
	status.slp_pair_hints = saved_slp_hints;
	status.slp_pair_vregs = saved_slp_vregs;

	status.buffer_data_cache = saved_buffer_cache;
	status.buffer_fold_cache = saved_fold_cache;
	status.array_ptr_cache = saved_array_cache;
	// The borrow registrations die with the loop body (a later build must not
	// treat an out-of-scope name as a borrowed slot). An enclosing loop's
	// registration stays (the nested flags).
	if (node.item_is_ref) {
		if (!saved_was_ref_param) {
			status.function_ref_params?.delete(item_name);
		}
		if (saved_item_alloc !== undefined) {
			status.register_allocations!.set(item_name, saved_item_alloc);
		}
	}
	status.loop_labels.pop();
	status.loop_writebacks?.pop();
	exit_scope_frame(status, old_scoped_declarations);
}

function is_enumerable_type(node: any, status: BuildStatus): boolean {
	if (node.node_type !== "value") return false;
	const type_name = node.value;
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	return struct.traits.includes("Enumerable");
}
