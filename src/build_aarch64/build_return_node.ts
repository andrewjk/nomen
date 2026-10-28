import emit_field_overrides, {
	has_field_overrides,
	hoist_field_overrides,
} from "../build/emit_field_overrides.ts";
import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { is_normalized_struct_call } from "../build_common/call_init_string_fields.ts";
import { override_return_string_fields } from "../build_common/ctor_return_owned.ts";
import ctor_return_owned_string_fields from "../build_common/ctor_return_owned.ts";
import {
	is_pure_borrow_element_load,
	struct_needs_auto_destroy,
} from "../build_common/destroy_analysis.ts";
import { direct_string_fields, owns_strings_uniformly } from "../build_common/has_string_fields.ts";
import { is_nullable_scalar_type } from "../build_common/nullable_scalar.ts";
import { is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import string_literal_length from "../build_common/string_literal_length.ts";
import {
	collect_expression_branch_values,
	is_call_site_borrow_accessor,
	is_container_borrow_access,
	is_owned_string_branch_value,
} from "../build_common/string_return_analysis.ts";
import tuple_return_owned_element from "../build_common/tuple_return_owned_element.ts";
import { is_float_type } from "../built_in_types.ts";
import type { NirExpr } from "../nir/nir.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { resolve_static_value } from "./build_array_values_node.ts";
import { get_source_address } from "./build_assignment_node.ts";
import { emit_nursery_joins_on_return_a64 } from "./build_async_block_node.ts";
import { emit_string_array_labels, resolve_array_element } from "./build_declaration_node.ts";
import { build_constructor_params, is_magic_spawn_ctor } from "./build_declaration_node.ts";
import { emit_struct_address } from "./build_function_call_node.ts";
import build_node from "./build_node.ts";
import { load_nullable_has } from "./build_operation_node.ts";
import { emit_typed_store } from "./build_struct_node.ts";
import { emit_expr_from_nir } from "./emit_nir.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_malloc, emit_strdup } from "./utils/audit.ts";
import {
	all_scope_frames,
	clear_heap_string_fields,
	emit_destroy_for_decl,
	emit_enum_payload_strdups_at,
	emit_heap_slots_cleanup_for_return,
	emit_moved_local_cleanup,
	emit_string_field_strdups_at,
	is_field_struct_borrow,
	mark_moved_if_struct,
	release_heap_string_fields,
} from "./utils/auto_destroy.ts";
import { build_swap_params } from "./utils/build_swap.ts";
import { emit_descriptor_address, materialize_func_value_a64 } from "./utils/closure_a64.ts";
import { allocate_stack_space, emit_var_address, emit_var_store } from "./utils/stack_var.ts";

let temp_counter = 0;
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { emit_pair_store_x29, emit_strdup_string } from "./utils/string_pair.ts";
import {
	emit_struct_copy,
	get_enum_sret_size,
	get_field_offset,
	get_struct_size,
} from "./utils/struct_layout.ts";
import { emit_view_materialize_owned, is_view_value } from "./utils/view_value.ts";

let return_val_counter = 0;

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations?.find((d) => d.name === name);
	if (decl?.type?.name) {
		return aarch64_size(decl.type.name);
	}
	return 8;
}

/**
 * Whether the function currently being built returns `string` (non-view).
 * `function_return_type` is populated for free functions and struct (sret)
 * returns, but NOT for struct methods returning a primitive — so fall back to
 * the declared return type on `current_struct`'s matching function.
 */
function current_return_is_string(status: BuildStatus): boolean {
	const rt = status.function_return_type;
	// A `ptr string` return is a bare machine word (the element-borrow
	// primitive's slot pointer — docs/HANDLERS.md Stage 4), never a fat
	// string: the strdup/ownership normalization must not fire on it.
	if (rt) return rt.name === "string" && !rt.is_view && !rt.is_pointer;
	if (status.current_struct && status.current_function_name) {
		const fn = status.current_struct.functions.find((f) => f.name === status.current_function_name);
		const frt = fn?.return_type;
		return !!frt && frt.name === "string" && !frt.is_view && !frt.is_pointer;
	}
	return false;
}

/**
 * Whether the function currently being built returns a float type. Float
 * returns follow the d0 convention: the value is handed back in `d0` (the
 * AArch64 FP result register), not as raw bits in x0. Mirrors
 * current_return_is_string's resolution — `function_return_type` is unset
 * for primitive-returning struct methods, so fall back to the declared
 * return type on `current_struct`'s matching function.
 */
function current_return_is_float(status: BuildStatus): boolean {
	const rt = status.function_return_type;
	if (rt) return is_float_type(rt.name);
	if (status.current_struct && status.current_function_name) {
		const fn = status.current_struct.functions.find((f) => f.name === status.current_function_name);
		return !!fn?.return_type && is_float_type(fn.return_type.name);
	}
	return false;
}

/**
 * Whether the function currently being built declares `mv out string` (the
 * signature-level ownership contract). Mirrors current_return_is_string's
 * resolution: `function_return_type` is unset for primitive-returning struct
 * methods, so resolve the FunctionNode from `current_struct`.
 */
function current_function_returns_move_string(status: BuildStatus): boolean {
	if (!status.current_struct || !status.current_function_name) return false;
	const fn = status.current_struct.functions.find((f) => f.name === status.current_function_name);
	return !!fn?.returns_move && fn.return_type?.name === "string" && !fn.return_type?.is_view;
}

/**
 * Emit a return VALUE expression. Under NIR-driven emission the lowered
 * `NirExpr` rides in and descends through `emit_expr_from_nir` (the
 * expression seam); without one (plain AST walk) it is exactly the
 * historical `build_node(value)`. Index-aligned with `value` by
 * construction — from_ast lowers 1:1.
 */
function emit_return_value(
	value: BaseNode,
	nir_value: NirExpr | null | undefined,
	status: BuildStatus,
): void {
	// A bare named function / declaration-lambda returned from a func-typed
	// return (`return five`): the value must be the function's closure
	// DESCRIPTOR address in x0 (CLOSURE.md), not its raw code address. The
	// checker stamps resolved_function on the value node (check_value_node).
	// A bare named function / declaration-lambda returned from a func-typed
	// return (`return five`): the value must be the function's closure
	// DESCRIPTOR address in x0 (CLOSURE.md), not its raw code address. The
	// checker stamps resolved_function on the value node (check_value_node).
	const resolved_func =
		value.node_type === "value" && status.function_return_type?.name === "func"
			? (value as unknown as { resolved_function?: FunctionNode }).resolved_function
			: undefined;
	if (resolved_func) {
		emit_descriptor_address(status, "x0", materialize_func_value_a64(resolved_func, status));
		return;
	}
	if (nir_value) {
		emit_expr_from_nir(nir_value, status);
		return;
	}
	build_node(value, status);
}

export default function build_return_node(
	node: ReturnNode,
	status: BuildStatus,
	nir_value?: NirExpr | null,
) {
	// Evaluate override values into temporaries before the base lands in the
	// return slot (see hoist_field_overrides).
	hoist_field_overrides(node.value, build_node, status);
	if (node.from_inline) {
		return;
	}

	// For a nullable struct/scalar return type, the sret buffer (x8) is sized
	// `struct_size + 8` (8 bytes for a scalar): bytes [0..size] hold the
	// value, the 8-byte word at [size] is the companion `_has` flag (0 = null,
	// 1 = value). The callee writes BOTH through x8 — the caller's local is
	// laid out the same way, so the sret writes land directly on the local's
	// value+flag (no extra copy or hardcoded flag at the call site).
	const returns_nullable_struct = is_nullable_struct_type(status.function_return_type, status);
	const returns_nullable_scalar = is_nullable_scalar_type(status.function_return_type, status);
	const nullable_ret_is_null =
		(returns_nullable_struct || returns_nullable_scalar) &&
		(!node.value ||
			(node.value.node_type === "value" && (node.value as ValueNode).value === "null"));
	if (nullable_ret_is_null) {
		// `return null`: write 0 to the flag slot in the sret buffer (the
		// value is left uninitialised — the caller won't read it when null).
		if (status.return_buffer_stack_offset !== undefined) {
			const struct_size = get_struct_size(status.function_return_type!.name, status);
			emit_asm(status, `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`);
			emit_asm(status, `str xzr, [x8, #${struct_size}]\n`);
		}
		// Run scope-exit cleanup for remaining declarations and jump to the
		// return epilogue (mirrors the void-return path above). The
		// enclosing nurseries' joins run first (join-before-destroy).
		emit_nursery_joins_on_return_a64(status);
		const finalized = status.moved ?? new Set<string>();
		// A return exits every enclosing scope, not just the innermost frame —
		// clean declarations from all of them (all_scope_frames).
		for (const decl of all_scope_frames(status).flat()) {
			if (finalized.has(decl.name)) {
				// A moved-out value struct still owns its recorded heap string
				// fields (store_T deep-copied them) — release them here since
				// the skip below bypasses emit_destroy_for_decl. Its
				// enum-with-data fields transfer with the blob (a variable
				// return's sret copy is bitwise), so they are deliberately NOT
				// freed here — the caller now owns them. An owning mv struct
				// whose move was CONDITIONAL keeps its destroy live on the
				// not-moved path, guarded on its runtime moved flag.
				emit_moved_local_cleanup(status, decl);
				continue;
			}
			if (is_field_struct_borrow(decl)) continue;
			// The `List<Own>.at()` pure borrow is not destroyed — the load
			// aliased destroy-worthy state the slot owns (see
			// is_pure_borrow_element_load).
			if (is_pure_borrow_element_load(decl, status)) continue;
			emit_destroy_for_decl(
				status,
				decl.name,
				decl.type.name,
				undefined,
				decl.type.type_args,
				decl.type.is_nullable,
			);
		}
		emit_heap_slots_cleanup_for_return(status);
		emit_asm(status, `b ${status.function_return_label}\n`);
		return;
	}

	if (!node.value) {
		if (status.return_assign) {
			const size = status.return_assign_size ?? find_var_size(status.return_assign, status);
			emit_asm(status, `mov x0, #0\n`);
			emit_var_store(status, "x0", status.return_assign, size);
		} else if (status.function_return_label) {
			emit_nursery_joins_on_return_a64(status);
			const finalized = status.moved ?? new Set<string>();
			for (const decl of all_scope_frames(status).flat()) {
				if (finalized.has(decl.name)) {
					// A moved-out value struct still owns its recorded heap string
					// fields (store_T deep-copied them) — release them here since
					// the skip below bypasses emit_destroy_for_decl. An owning mv
					// struct whose move was CONDITIONAL keeps its destroy live on
					// the not-moved path, guarded on its runtime moved flag.
					emit_moved_local_cleanup(status, decl);
					continue;
				}
				if (is_field_struct_borrow(decl)) continue;
				// The `List<Own>.at()` pure borrow is not destroyed — see
				// is_pure_borrow_element_load.
				if (is_pure_borrow_element_load(decl, status)) continue;
				emit_destroy_for_decl(
					status,
					decl.name,
					decl.type.name,
					undefined,
					decl.type.type_args,
					decl.type.is_nullable,
				);
			}
			emit_heap_slots_cleanup_for_return(status);
			emit_asm(status, `mov x0, #0\n`);
			emit_asm(status, `b ${status.function_return_label}\n`);
		}
		return;
	}

	// Array literal return (e.g. `return [1, 2, 3]`): arrays can't be returned
	// by value, so materialize the literal into a stack buffer first. The
	// generic array-return path below then heap-allocates an Array_<T> buffer
	// and copies the stack data into it (mirrors a `var nums = [1, 2, 3]` decl).
	const return_type_top = status.function_return_type;
	let array_literal_len = 0;
	let array_literal_offset = 0;
	if (return_type_top?.is_array && node.value.node_type === "array") {
		const arr = node.value as ArrayValuesNode;
		array_literal_len = arr.values.length;
		const struct_element = status.structs.find(
			(s) => s.name === return_type_top.name && !s.is_simple_type,
		);
		const element_size = struct_element
			? struct_element.is_class
				? 8
				: get_struct_size(return_type_top.name, status)
			: aarch64_size(return_type_top.name);
		const start = allocate_stack_space(status, 8 + array_literal_len * element_size, element_size);
		emit_asm(status, `mov x0, #${array_literal_len}\n`);
		emit_asm(status, `str x0, [x29, #${start}]\n`);
		array_literal_offset = start + 8;
		// String elements are stored as pointers to static (.asciz) labels —
		// matching how a `var words = ["a", "b"]` declaration lays them out
		// (rodata, not heap, so the audit stays balanced without per-element frees).
		const is_string_array = return_type_top.name === "string";
		const str_labels = is_string_array
			? emit_string_array_labels(arr.values, status)
			: new Map<string, string>();
		arr.values.forEach((value, i) => {
			const slot = array_literal_offset + i * element_size;
			const raw = resolve_static_value(value, status);
			if (raw !== null && is_string_array) {
				// Fat-string row: {strdup(label ptr), compile-time len}. The
				// strdup makes the buffer OWN its rows — scope-exit destroy
				// frees each slot, so rodata pointers must never land here.
				const label = resolve_array_element(raw, str_labels);
				emit_asm(status, `adr x0, ${label}\n`);
				emit_strdup(status);
				emit_asm(status, `mov x1, #${string_literal_length(raw)}\n`);
				emit_pair_store_x29(status, slot, "x0", "x1");
			} else if (raw !== null) {
				emit_asm(status, `mov x0, #${raw}\n`);
				if (element_size === 1) {
					emit_asm(status, `strb w0, [x29, #${slot}]\n`);
				} else if (element_size === 4) {
					emit_asm(status, `str w0, [x29, #${slot}]\n`);
				} else {
					emit_asm(status, `str x0, [x29, #${slot}]\n`);
				}
			} else {
				// NIR mode: array literals lower to a `call` whose args are the
				// lowered elements, index-aligned with arr.values.
				const nir_elem =
					nir_value?.kind === "call" && nir_value.node === arr
						? nir_value.facts.args[i]
						: undefined;
				emit_return_value(value, nir_elem, status);
				ensure_newline(status);
				emit_asm(status, `str x0, [x29, #${slot}]\n`);
			}
		});
	}

	// STRUCT_PLAN_3 B4 — a value-struct conformer returned from a
	// trait-typed function boxes at the return boundary (T4: handles at
	// every trait position): the handle in x0 is a heap instance whose
	// first word is the conformer's vtable. A bare local's bytes MOVE into
	// the box (its teardown is suppressed — the transfer marks below); any
	// other concrete expression builds into a stack scratch and is copied,
	// with every direct string field strdup'd (the box's destroy frees
	// every string field it holds).
	if (
		status.function_return_label &&
		!status.return_assign &&
		status.function_return_type &&
		!!status.traits.find((t) => t.name === status.function_return_type!.name) &&
		!status.function_return_type.is_view &&
		!status.function_return_type.is_array
	) {
		const val_t = type_from_value_node(node.value);
		const val_struct = val_t?.name
			? status.structs.find(
					(st) => st.name === val_t.name && !st.is_simple_type && !st.is_class && !st.is_generic,
				)
			: undefined;
		if (val_struct) {
			const box_size = get_struct_size(val_struct.name, status);
			// Park the box pointer in a frame slot: the constructor call (and
			// the strdup `bl`s) clobber x0, and the function must RETURN the
			// box handle in x0.
			// A mv struct's direct string fields are uniformly heap; the
			// mv transfers them to the box (strdup'ing would orphan the
			// donor's copy — LEAK). See build_function_call_node's box helper.
			const strdup_string_fields =
				!owns_strings_uniformly(val_struct) &&
				!val_struct.functions.some((f) => f.name === "#destroy") &&
				struct_needs_auto_destroy(val_struct, status);
			const box_slot = allocate_stack_space(status, 8, 8);
			if (
				node.value.node_type === "func_call" &&
				(node.value as FunctionCallNode).name === val_struct.name &&
				!is_magic_spawn_ctor(node.value as FunctionCallNode)
			) {
				const func_call = node.value as FunctionCallNode;
				emit_asm(status, `mov x0, #${box_size}\n`);
				emit_malloc(status);
				emit_asm(status, `str x0, [x29, #${box_slot}]\n`);
				const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
				const outgoing = build_constructor_params(func_call, param_regs, status);
				emit_asm(status, `ldr x0, [x29, #${box_slot}]\n`);
				emit_asm(status, `bl ${func_call.mangled_name ?? `${func_call.name}_init`}\n`);
				if (outgoing > 0) emit_asm(status, `add sp, sp, #${outgoing}\n`);
				if (func_call.move_param_indices?.length) {
					for (const idx of func_call.move_param_indices) {
						mark_moved_if_struct(func_call.params[idx], status);
					}
				}
				build_swap_params(func_call, status);
				emit_asm(status, `ldr x0, [x29, #${box_slot}]\n`);
				if (strdup_string_fields) {
					emit_string_field_strdups_at(status, val_struct.name, "x0");
				}
			} else {
				emit_struct_address(node.value, status);
				ensure_newline(status);
				// Park the source address in a frame slot: the malloc `bl`
				// clobbers x0-x18 (x2 would not survive it).
				const src_slot = allocate_stack_space(status, 8, 8);
				emit_asm(status, `str x0, [x29, #${src_slot}]\n`);
				emit_asm(status, `mov x0, #${box_size}\n`);
				emit_malloc(status);
				emit_asm(status, `str x0, [x29, #${box_slot}]\n`);
				emit_asm(status, `mov x1, x0\n`);
				emit_asm(status, `ldr x2, [x29, #${src_slot}]\n`);
				const words = Math.ceil(box_size / 8);
				for (let w = 0; w < words; w++) {
					emit_asm(status, `ldr x3, [x2, #${w * 8}]\n`);
					emit_asm(status, `str x3, [x1, #${w * 8}]\n`);
				}
				let skip_fields: Set<string> | undefined;
				if (node.value.node_type === "value") {
					const donor = (node.value as ValueNode).value;
					const prefix = `${donor}.`;
					for (const key of status.heap_string_fields ?? []) {
						if (key.startsWith(prefix)) {
							skip_fields ??= new Set<string>();
							skip_fields.add(key.slice(prefix.length));
						}
					}
				}
				if (strdup_string_fields) {
					emit_string_field_strdups_at(status, val_struct.name, "x1", 0, skip_fields);
				}
				emit_asm(status, `ldr x0, [x29, #${box_slot}]\n`);
			}
			// Transfer marks: the donor's bytes live in the box now — the
			// return cleanup must not free them or their recorded strings.
			mark_moved_if_struct(node.value, status, { for_return: true });
			if (node.value.node_type === "value") {
				clear_heap_string_fields(status, (node.value as ValueNode).value);
			}
			const finalized = status.moved ?? new Set<string>();
			emit_asm(status, `str x0, [sp, #-16]!\n`);
			emit_nursery_joins_on_return_a64(status);
			for (const decl of all_scope_frames(status).flat()) {
				if (finalized.has(decl.name)) {
					release_heap_string_fields(status, decl.name, decl.type.name, decl.type.is_nullable);
					continue;
				}
				if (is_field_struct_borrow(decl)) continue;
				// The `List<Own>.at()` pure borrow is not destroyed — see
				// is_pure_borrow_element_load.
				if (is_pure_borrow_element_load(decl, status)) continue;
				emit_destroy_for_decl(
					status,
					decl.name,
					decl.type.name,
					undefined,
					decl.type.type_args,
					decl.type.is_nullable,
				);
			}
			emit_heap_slots_cleanup_for_return(status);
			emit_asm(status, `ldr x0, [sp], #16\n`);
			emit_asm(status, `b ${status.function_return_label}\n`);
			return;
		}
	}

	let return_join_owned_string = false;
	if (array_literal_len > 0) {
		emit_asm(status, `add x0, x29, #${array_literal_offset}\n`);
	} else if (
		!status.return_assign &&
		(node.value.node_type === "match" ||
			node.value.node_type === "switch" ||
			node.value.node_type === "if")
	) {
		// `return match/switch/if` mirrors the C backend's `_return_val` path:
		// control-flow expressions assign each branch's value to a join slot
		// instead of leaving it in x0 at the join point. A branch whose value
		// needs hoisted interpolation temps runs its scope-exit auto-free
		// (`ldr x0, [x29, #N]; bl _nomen_free_wrap`) after producing the
		// value, clobbering x0 before the join — the caller would receive a
		// strdup of a freed pointer. Storing to the slot before that cleanup
		// (the branch's let/return assign through return_assign) keeps the
		// chosen branch's result live across the join.
		const slot_name = `_return_val_${return_val_counter++}`;
		const ret_size = status.function_return_type
			? Math.max(aarch64_size(status.function_return_type.name), 8)
			: 8;
		const slot = allocate_stack_space(status, ret_size);
		status.stack_offsets!.set(slot_name, slot);
		// Mixed string-join ownership normalization (mirrors the C backend):
		// when any branch produces a fresh owned heap string
		// (interpolation/concat/call), flag the branch builds so every
		// non-owned branch value (a literal's rodata pointer, a borrow) is
		// strdup'd into the slot (build_let_node) — the slot then uniformly
		// owns its result and is returned DIRECTLY. A join-point strdup would
		// copy the owned original and leak it.
		return_join_owned_string =
			current_return_is_string(status) &&
			collect_expression_branch_values(node.value).some((v) =>
				is_owned_string_branch_value(v, status),
			);
		const old_return_assign = status.return_assign;
		const old_return_assign_size = status.return_assign_size;
		const old_join_owned = status.join_needs_owned_string;
		status.return_assign = slot_name;
		status.return_assign_size = ret_size;
		if (return_join_owned_string) status.join_needs_owned_string = true;
		build_node(node.value, status);
		status.join_needs_owned_string = old_join_owned;
		status.return_assign = old_return_assign;
		status.return_assign_size = old_return_assign_size;
		// Reload the chosen branch's value from the slot (x0 was clobbered by
		// the branch scope-exit cleanup) and hand the owned result to the
		// caller as-is.
		emit_asm(status, `ldr x0, [x29, #${slot}]\n`);
		// Trait-boxing join (FOLLOWUP "return <computed concrete> from a
		// trait-returning function inside a switch/match/if join"): the slot
		// holds the ADDRESS of the winning branch's stack temp — returning it
		// as the trait handle hands the caller a pointer into this (dying)
		// frame. Box the winner at the join point: the temp is still live in
		// this frame, so copy its bytes into a malloc'd box (same malloc +
		// strdup contract as the direct-expression box branch above) and
		// return the handle. The conformer comes from the BRANCH VALUES (the
		// checker leaves the join expression's own type unstamped in return
		// position).
		{
			const join_branch_values = collect_expression_branch_values(node.value);
			const first_branch_type = join_branch_values.length
				? type_from_value_node(join_branch_values[0])?.name
				: undefined;
			const uniform_branch_type =
				first_branch_type &&
				join_branch_values.every((v) => type_from_value_node(v)?.name === first_branch_type);
			const join_val_struct =
				status.function_return_type &&
				!!status.traits.find((t) => t.name === status.function_return_type!.name) &&
				!status.function_return_type.is_view &&
				!status.function_return_type.is_array &&
				uniform_branch_type
					? status.structs.find(
							(st) =>
								st.name === first_branch_type &&
								!st.is_simple_type &&
								!st.is_class &&
								!st.is_generic,
						)
					: undefined;
			if (join_val_struct) {
				const box_size = get_struct_size(join_val_struct.name, status);
				const strdup_string_fields =
					!owns_strings_uniformly(join_val_struct) &&
					!join_val_struct.functions.some((f) => f.name === "#destroy") &&
					struct_needs_auto_destroy(join_val_struct, status);
				// Park the source address in a frame slot: the malloc `bl`
				// clobbers x0-x18 (x2 would not survive it).
				const src_slot = allocate_stack_space(status, 8, 8);
				emit_asm(status, `str x0, [x29, #${src_slot}]\n`);
				emit_asm(status, `mov x0, #${box_size}\n`);
				emit_malloc(status);
				emit_asm(status, `mov x1, x0\n`);
				emit_asm(status, `ldr x2, [x29, #${src_slot}]\n`);
				const words = Math.ceil(box_size / 8);
				for (let w = 0; w < words; w++) {
					emit_asm(status, `ldr x3, [x2, #${w * 8}]\n`);
					emit_asm(status, `str x3, [x1, #${w * 8}]\n`);
				}
				if (strdup_string_fields) {
					emit_string_field_strdups_at(status, join_val_struct.name, "x1");
				}
				emit_asm(status, `mov x0, x1\n`);
			}
		}
		if (current_return_is_float(status)) {
			emit_asm(status, `fmov d0, x0\n`);
		}
		if (return_join_owned_string) {
			status.last_result_is_heap = true;
		}
	} else {
		// `return T(...) + [ ... ]`: the constructor would normally write
		// straight into the return buffer (struct_return_buffer), bypassing
		// the temp where field overrides are applied. Force the temp path for
		// override constructors so the overrides land on the temp, then the
		// copy below (x0 → return buffer) carries them through.
		const override_ctor = has_field_overrides(node.value);
		const saved_buffer = override_ctor ? status.struct_return_buffer : undefined;
		if (override_ctor) status.struct_return_buffer = undefined;
		// A float return rides the d0 convention — request the d0 fast path
		// so a float-op value leaves its result directly in d0 (no
		// fmov-to-x0-then-back). Non-op values (variables, literals, calls)
		// don't consume the flag and land in x0; the tail below moves them.
		const ret_is_float = current_return_is_float(status);
		if (ret_is_float) status.float_result_in_d0 = true;
		if (node.value?.node_type === "anon_struct") {
			// `return [ .. <base>, f = v ]`: copy the base into a fresh temp
			// (the return must not alias the base's storage), apply the
			// overrides to the temp, and leave x0 = temp address so the copy
			// below (x0 → return buffer) carries the full value through.
			// The temp is named with the `_return_val` prefix so
			// emit_field_overrides' sret gate applies (no carrier type on the
			// synthetic assignments): an override store at the return boundary
			// stays a RAW borrow — routing it through the strdup+record field
			// lowering would orphan the heap-field record at the struct-return
			// boundary (the caller's copy is untracked → leak; the
			// new_block receipt leaked one strdup per factory call). The
			// override-constructor ownership gap at this boundary is the
			// documented FOLLOWUP item.
			const anon = node.value as AnonStructNode;
			const struct_size = get_struct_size(anon.type!.name, status);
			const temp_name = `_return_val_anon_${temp_counter++}`;
			const offset = allocate_stack_space(status, struct_size);
			status.stack_offsets!.set(temp_name, offset);
			if (!status.variable_types) status.variable_types = new Map();
			status.variable_types.set(temp_name, anon.type!);
			get_source_address(anon.base!, status);
			ensure_newline(status);
			emit_var_address(status, "x1", temp_name);
			emit_struct_copy("x0", "x1", 0, struct_size, status);
			if ((anon.base! as ValueNode).is_moved) {
				mark_moved_if_struct(anon.base!, status);
			}
			// A FORWARDED normalizing base (a registered returner) owns DEEP
			// COPIES in its string fields — the override stores below would
			// displace them un-freed — so reclaim each overridden string
			// field's displaced value before the raw store.
			if (anon.base!.node_type === "func_call" && is_normalized_struct_call(anon.base!, status)) {
				const base_struct = status.structs.find(
					(s) => s.name === anon.type!.name && !s.is_simple_type && !s.is_class,
				);
				if (base_struct) {
					for (const field of direct_string_fields(base_struct)) {
						if (!anon.fields.some((o) => o.name === field.name)) continue;
						const field_off = get_field_offset(base_struct.name, field.name, status);
						emit_asm(status, `ldp x0, x1, [x29, #${offset + field_off}]\n`);
						emit_asm(status, `bl _nomen_free_wrap\n`);
					}
				}
			}
			emit_field_overrides(temp_name, anon, build_node, status);
			emit_var_address(status, "x0", temp_name);
		} else {
			// Reset the owned-result flag so the value build below gives a
			// FRESH answer: a builder that produces a fresh heap string sets
			// it true; a borrow-producing builder leaves it false. Closures
			// read it (needs_borrow_strdup) to decide whether a call result
			// must be dup'd — a stale true from an earlier statement would
			// otherwise let a borrow through and the indirect caller would
			// free it.
			status.last_result_is_heap = false;
			// Return-side NRVO: the binding has no storage — it
			// IS the caller's sret buffer — so the value build (an address
			// load that would fall back to a global `adr`) is skipped; the
			// sret block below emits nothing either.
			if (!(node as ReturnNode).nrvo_elided) {
				emit_return_value(node.value, nir_value, status);
			}
		}
		if (ret_is_float) {
			ensure_newline(status);
			if (status.float_result_in_d0) {
				// Flag unconsumed — value is in x0 as raw bits.
				emit_asm(status, `fmov d0, x0\n`);
			}
			status.float_result_in_d0 = false;
		}
		if (override_ctor) status.struct_return_buffer = saved_buffer;
	}
	ensure_newline(status);

	// A `view string` return of a NON-view expression (an owned string, a
	// field read, a literal) must leave the (ptr, len) pair in x0/x1 — the
	// fat value build already produced the pair in x0/x1, so it passes
	// through unchanged. (A view-typed value likewise already produced the
	// pair.)

	// A bare string literal returned from a heap-returning function is
	// strdup'd so the caller frees a heap copy, mirroring the C backend's
	// `returns_string_literal` path in build_return_node. A function with at
	// least one heap-producing branch is classified heap-returning, so the
	// caller frees EVERY result from it — but the literal branch lowers to
	// `adr x0, _str_N` (a rodata pointer) which free rejects (SIGABRT). A
	// function that returns ONLY literals is not heap-returning (the caller
	// doesn't free), so the rodata pointer is safe and no strdup is emitted.
	if (
		current_return_is_string(status) &&
		node.value.node_type === "value" &&
		(node.value as ValueNode).value.length >= 2 &&
		(node.value as ValueNode).value.startsWith('"') &&
		(node.value as ValueNode).value.endsWith('"')
	) {
		const fn_name = status.current_function_name;
		const mangled = status.current_struct ? `${status.current_struct.name}_${fn_name}` : fn_name;
		if (
			fn_name && // A LAMBDA's literal return must be heap-owned too (its callers are
			// indirect and free every string result — see normalizes_borrow_returns).
			// A STRUCT METHOD's literal return joins it: methods are the only
			// vtable-dispatchees, so a dispatched call site frees every string
			// result — a rodata literal would be freed.
			(status.current_function_is_closure ||
				!!status.current_struct ||
				(!!status.heap_returning_functions &&
					(status.heap_returning_functions.has(fn_name) ||
						(mangled !== undefined && status.heap_returning_functions.has(mangled)))) ||
				// A `mv out string` function hands the caller an OWNED value by
				// signature — a literal return path must be copied into heap
				// storage or the caller frees rodata.
				current_function_returns_move_string(status))
		) {
			// strdup the ptr half, keep the len half (x1 survives the call).
			emit_strdup_string(status);
			ensure_newline(status);
			status.last_result_is_heap = true;
		}
	}

	// Borrow normalization at the return boundary. A string-returning
	// function classified heap-returning hands the caller a value the caller
	// FREES unconditionally, so every return path must produce a heap
	// pointer. A return whose value is statically NON-heap — a borrowed bare
	// variable (a parameter, a literal-initialized local, or a local
	// initialized from a container-borrow accessor), a container/buffer
	// borrow accessor call (`.at`/`.first`/`.slice`/`load_T`), a field
	// access, or a match/switch whose chosen branch produced any of those —
	// is strdup'd here so the caller frees an independent copy. This mirrors
	// the C backend's boundary-strdup (whose caller frees every string call
	// result), closing the backend divergence where this backend passed the
	// raw borrow through: returning `xs.at(i)` used to hand the caller a
	// borrow tied to the receiver's storage instead of an owned copy.
	//
	// Inside the call-site borrow accessors' OWN bodies (a function named
	// `at`/`first`, e.g. `List<string>.at`'s `return self.items.load_T(i)`)
	// the borrow passes through UNCHANGED: their call sites treat the result
	// as a non-owned borrow and never free it (the shared `is_string_borrow`
	// rule), so a copy would hand those callers a heap allocation they never
	// free.
	const borrow_fn_name = status.current_function_name;
	const borrow_mangled =
		status.current_struct && borrow_fn_name
			? `${status.current_struct.name}_${borrow_fn_name}`
			: undefined;
	const normalizes_borrow_returns =
		!!borrow_fn_name &&
		!is_call_site_borrow_accessor(borrow_fn_name) &&
		current_return_is_string(status) &&
		// Either the function is classified heap-returning (its callers free
		// every result), it declares `mv out string` (the caller owns the
		// result by signature), it is a LAMBDA — closures are only ever
		// called through a descriptor (indirect), where the call site cannot
		// know the callee's return classification, so every closure string
		// return must be uniformly heap-owned (CLOSURE.md fix (a); mirrors the
		// C backend, which strdups every string return) — or it is a STRUCT
		// METHOD. Methods are the only vtable-dispatchees (trait objects):
		// like a closure, a dispatched call site cannot classify the callee
		// statically, so the B1 uniform-heap contract applies to every method
		// string return the same way. In all cases every return path must
		// hand over a heap pointer.
		(!!status.current_function_is_closure ||
			!!status.current_struct ||
			(!!status.heap_returning_functions &&
				(status.heap_returning_functions.has(borrow_fn_name) ||
					(borrow_mangled !== undefined && status.heap_returning_functions.has(borrow_mangled)))) ||
			current_function_returns_move_string(status));
	let needs_borrow_strdup = false;
	if (normalizes_borrow_returns) {
		if (node.value.node_type === "value") {
			const raw_value = (node.value as ValueNode).value;
			const is_str_lit =
				raw_value.length >= 2 && raw_value.startsWith('"') && raw_value.endsWith('"');
			const is_numeric = /^(\+|-)?\d+$/.test(raw_value);
			// A bare VARIABLE whose current value is not a heap allocation
			// owned by this frame (not in heap_strings) holds a borrow — copy
			// it. String literals are excluded (handled above), numerics are
			// excluded (`return 0` hands the caller NULL, which free
			// tolerates), and `null` is excluded (`return null` in a
			// `string?`/nullable return hands back a null pair — strdup'ing it
			// passes a null pointer to strdup and aborts). A var in
			// heap_strings transfers ownership directly (mark_moved_if_struct
			// below skips its scope-exit free).
			if (
				!is_str_lit &&
				!is_numeric &&
				raw_value !== "null" &&
				!status.heap_strings?.has(raw_value)
			) {
				needs_borrow_strdup = true;
			}
		} else if (is_container_borrow_access(node.value)) {
			// `return xs.at(i)` / `.first()` / `.slice(...)` / `load_T` — a
			// view into the receiver's storage (or rodata for a stored
			// literal element).
			needs_borrow_strdup = true;
		} else if (
			node.value.node_type === "access" &&
			(node.value as AccessNode).access.node_type === "access_field"
		) {
			// `return self.name` / `return obj.field` — the storage belongs
			// to the struct instance.
			needs_borrow_strdup = true;
		} else if (
			// A CALL result the callee classification did NOT mark as owned
			// (a trait-dispatched method handing back a field/literal borrow,
			// a borrow accessor reached indirectly, a plain `get`-style
			// method returning `self.item`): dup it so the freeing caller
			// receives an owned copy while the callee's storage keeps the
			// original. The value build above reset `last_result_is_heap`
			// and set it only for owned results, giving a fresh signal here.
			// Before the loop-promotion field-store dup made value-struct
			// fields heap-owned, a field-borrow call result could only alias
			// rodata/borrow storage that was never freed; now the owner's
			// scope-exit reclaim frees it, so passing the raw pair through
			// handed the caller a dangling pointer (the StrBox `get` receipt:
			// `return b.get()` printed garbage after go freed b.item).
			(node.value.node_type === "func_call" ||
				(node.value.node_type === "access" &&
					(node.value as AccessNode).access.node_type === "access_func")) &&
			!status.last_result_is_heap &&
			!is_container_borrow_access(node.value)
		) {
			needs_borrow_strdup = true;
		} else if (
			(node.value.node_type === "match" || node.value.node_type === "switch") &&
			!return_join_owned_string
		) {
			// The chosen branch's value is in x0; with no owned branch every
			// branch produced a borrow/literal (e.g. `return match c { 1 ->
			// xs.at(0), else -> "none" }`), so copy it for the freeing caller.
			// A mixed join with an owned branch is excluded: it is normalized
			// per-branch into the join slot and returned directly.
			needs_borrow_strdup = true;
		}
	}
	if (needs_borrow_strdup) {
		// A `view string` value materializes with a LENGTH-BOUNDED copy —
		// a thin strdup would over-read past the view's end (views into the
		// middle of a buffer are not NUL-terminated there). Restricted to
		// value/access shapes whose build leaves the pair in x0/x1.
		if (
			is_view_value(node.value, status) &&
			(node.value.node_type === "value" || node.value.node_type === "access")
		) {
			emit_view_materialize_owned(status);
		} else {
			emit_strdup_string(status);
		}
		ensure_newline(status);
		status.last_result_is_heap = true;
	}

	// A string return whose value is a CALL result the callee classification
	// did NOT mark as owned — while this function's scope exit will reclaim
	// recorded heap string fields — must hand the caller a COPY: the call may
	// have returned a field borrow of a local this exit frees (a `get`-style
	// method returning `self.item`), and freeing the field invalidates the
	// returned pair (the StrBox receipt: `return b.get()` printed garbage
	// once value-struct field stores owned their copies). The function is
	// stamped heap-returning so its callers free the copy — the gather pass
	// classified it before this body built (a call return was conservatively
	// borrow); direct call sites built AFTER this function see the stamp.
	if (
		!needs_borrow_strdup &&
		current_return_is_string(status) &&
		!is_container_borrow_access(node.value) &&
		(node.value.node_type === "func_call" ||
			(node.value.node_type === "access" &&
				(node.value as AccessNode).access.node_type === "access_func")) &&
		!status.last_result_is_heap
	) {
		// STRUCT_PLAN_3 B1 cutover: the old `heap_string_fields?.size` gate is
		// dead — OWNING structs (every string-field struct, post-cutover)
		// never record; their scope-exit destroy frees the fields
		// unconditionally. A non-heap call result may alias such a local's
		// field (the StrBox receipt: `return b.get()` printed garbage after
		// go freed b.item), so the copy is unconditional now — the same
		// blanket boundary strdup the C backend has always applied. The
		// container-borrow accessors above stay excluded (their call sites
		// treat the result as a borrow and never free it).
		emit_strdup_string(status);
		ensure_newline(status);
		status.last_result_is_heap = true;
		if (borrow_fn_name) {
			status.heap_returning_functions?.add(borrow_fn_name);
			if (borrow_mangled !== undefined) {
				status.heap_returning_functions?.add(borrow_mangled);
			}
		}
	}

	// STRUCT_PLAN_3 B1 cutover: `return <local>.<string field>` — the local's
	// string fields are uniformly heap-owned post-cutover (the ctor strdup'd
	// the seed, stores strdup non-heap RHS, load-accessor bindings strdup),
	// so the read is a heap value the local's own scope-exit destroy frees
	// BEFORE the branch. Pre-B1 the field could be a rodata/borrow alias and
	// an unclassified function passed the raw pair through (the caller
	// borrows it) — that pair now dangles. Dup it for the caller and stamp
	// the function heap-returning so call sites free the copy — the same
	// blanket normalization the call-result arm above applies and the C
	// backend has always applied to every string return.
	if (
		!needs_borrow_strdup &&
		current_return_is_string(status) &&
		node.value.node_type === "access" &&
		(node.value as AccessNode).access.node_type === "access_field" &&
		!status.last_result_is_heap
	) {
		emit_strdup_string(status);
		ensure_newline(status);
		status.last_result_is_heap = true;
		if (borrow_fn_name) {
			status.heap_returning_functions?.add(borrow_fn_name);
			if (borrow_mangled !== undefined) {
				status.heap_returning_functions?.add(borrow_mangled);
			}
		}
	}

	// A `move_T` result returned from a string-returning function (e.g.
	// `List<string>.pop`'s `return self.items.move_T(idx)`) relinquishes a
	// `Buffer<string>` slot. The slot owns an independent heap copy (store_T
	// strdup's), so the returned `char*` is already a heap pointer — it is
	// handed to the caller as-is, NO strdup. Mark the function heap-returning
	// so the caller frees the result. (When slots held shallow borrows, the
	// slot could be rodata and a return-site strdup was required; mv slots
	// make it redundant and a leak.)
	//
	// `function_return_type` is only populated for struct (sret) returns, so
	// for a struct method returning a primitive (like `string`) we look up the
	// declared return type on the current struct's function instead.
	const move_T_ret_is_string =
		node.value.node_type === "access" &&
		(node.value as AccessNode).access.node_type === "access_func" &&
		(node.value as AccessNode).access.name === "move" &&
		current_return_is_string(status);
	if (move_T_ret_is_string) {
		status.last_result_is_heap = true;
	}

	if (status.last_result_is_heap && current_return_is_string(status)) {
		if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
		if (status.current_function_name) {
			if (process.env.NOMEN_DBG_HEAP)
				console.error(`DBG registering heap-returning: ${status.current_function_name}`);
			status.heap_returning_functions.add(status.current_function_name);
		}
	}

	if (returns_nullable_scalar && status.function_return_label && status.struct_return_buffer) {
		// A nullable SCALAR return: store the value (already in x0) and the
		// companion `_has` flag into the caller's sret buffer — value at +0
		// (natural width), flag word at +8. The flag is FORWARDED when the
		// returned value is itself a nullable scalar local/param/field
		// (`return x`); otherwise the value is real (flag = 1).
		if (status.return_buffer_stack_offset !== undefined) {
			emit_asm(status, `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`);
		}
		const scalar_size = aarch64_size(status.function_return_type!.name);
		emit_typed_store(status, "x0", "x8", 0, scalar_size);
		const value_type = node.value ? type_from_value_node(node.value) : undefined;
		if (node.value && value_type?.is_nullable && is_nullable_scalar_type(value_type, status)) {
			load_nullable_has(node.value, "x9", status);
			ensure_newline(status);
			emit_asm(status, `str x9, [x8, #8]\n`);
		} else {
			emit_asm(status, `mov x9, #1\n`);
			emit_asm(status, `str x9, [x8, #8]\n`);
		}
	}

	if (status.function_return_label && status.struct_return_buffer && status.function_return_type) {
		const ret_struct = status.structs.find(
			(s) => s.name === status.function_return_type!.name && !s.is_simple_type && !s.is_class,
		);
		// An enum-with-data return shares the sret convention: copy the
		// tag+payload blob into the caller-provided x8 buffer (sized by
		// get_enum_size). The copy happens HERE — before the scope-exit
		// destroy `bl`s below — so the source bytes (a callee frame for a
		// `return f()` value, or this frame's temps) are still live.
		const ret_enum_size = ret_struct
			? undefined
			: get_enum_sret_size(status.function_return_type!.name, status);
		if (ret_struct || ret_enum_size !== undefined) {
			// Return-side NRVO: the returned binding constructed
			// directly in the caller's sret buffer (DeclarationNode.nrvo_sret)
			// — the byte-copy is its own construct, not a copy.
			if (status.return_buffer_stack_offset !== undefined) {
				emit_asm(status, `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`);
			}
			const struct_size = ret_struct
				? get_struct_size(status.function_return_type!.name, status)
				: ret_enum_size!;
			// A `value` node is a plain variable/param reference — EXCEPT an
			// enum case shorthand (`.none`, checker-stamped to its mono name),
			// which is not a declaration: its build already left x0 pointing at
			// the tag+payload temp, so copy straight from x0.
			if ((node as ReturnNode).nrvo_elided) {
				// The data is already in the caller's buffer; the trailing
				// nullable-flag / payload work below still applies where the
				// shapes demand it (the NRVO gate excludes nullable returns).
			} else if (node.value.node_type === "value" && !(node.value as ValueNode).is_enum_shorthand) {
				const var_name = (node.value as ValueNode).value;
				const paramReg = status.function_param_regs?.get(var_name);
				if (paramReg) {
					emit_struct_copy(paramReg, "x8", 0, struct_size, status);
				} else {
					emit_var_address(status, "x0", var_name);
					emit_struct_copy("x0", "x8", 0, struct_size, status);
				}
			} else {
				emit_struct_copy("x0", "x8", 0, struct_size, status);
			}
			// For a nullable STRUCT return, the sret buffer is sized
			// `struct_size + 8` and the 8-byte word at [struct_size] is the
			// companion `_has` flag. We've just copied the non-null value —
			// write `1` so the caller sees the result as non-null. (The
			// null-return path is handled at the top of this function.)
			// Enums are never nullable, so this stays struct-only.
			if (ret_struct && returns_nullable_struct) {
				emit_asm(status, `mov x9, #1\n`);
				emit_asm(status, `str x9, [x8, #${struct_size}]\n`);
			}
			// An enum-with-data return from a FIELD READ (`return self.m`)
			// takes OWNING copies of the active case's string payloads on the
			// sret buffer: the bitwise copy shares them with the struct, whose
			// destroy frees them — the caller's value must be independent.
			// Variable and call results TRANSFER their payloads (the source is
			// moved, or a temp with no reclaim of its own), so copying those
			// would leak the original.
			const ret_src_is_field_read =
				node.value.node_type === "access" &&
				(node.value as AccessNode).access?.node_type === "access_field";
			if (ret_enum_size !== undefined && ret_src_is_field_read) {
				emit_enum_payload_strdups_at(status, status.function_return_type!.name, "x8");
			} else if (ret_struct && ret_src_is_field_read) {
				for (const field of ret_struct.fields) {
					if (field.type.is_ref || field.type.is_view || field.type.is_array) continue;
					const field_enum = status.enums.find(
						(e) => e.name === field.type.name && e.has_associated_data,
					);
					if (!field_enum) continue;
					const field_off = get_field_offset(ret_struct.name, field.name, status);
					emit_enum_payload_strdups_at(status, field_enum.name, "x8", field_off);
				}
			}
			// Return-boundary normalization for value structs with string
			// fields, for the TRANSFER shape only: `return <bare
			// local/parameter>`. The returned variable dies at the return, so
			// the boundary makes the value uniformly heap-owned — recorded
			// (heap) fields transfer raw (their records are cleared below),
			// unrecorded fields (rodata or borrows) are strdup'd on the sret
			// buffer — and the caller records every string field of a binding
			// of a REGISTERED normalizing function and frees them at scope
			// exit (see record_call_init_string_fields). Every other shape
			// keeps the status quo: forwarded registered calls already carry
			// uniformly-owned values, container borrow accessors keep their
			// slot-owned borrow semantics, and owned accessors (move_T) are
			// freed by the recorded caller without an extra copy. The set of
			// normalizing functions comes from the whole-program pre-pass
			// (struct_return_classification.ts).
			// STRUCT_PLAN_3 B6: a NULLABLE struct return normalizes too — the
			// caller's binding of a registered normalizer records the string
			// fields as heap (flag-guarded free), so the boundary must strdup
			// the same shapes as the non-nullable path. The `_has` flag write
			// above is unaffected (the strdups retarget the field bytes only).
			if (ret_struct) {
				// A LOCAL only: `return <param>` aliases the caller's argument
				// (params pass by address) — normalizing it would hand the
				// caller fresh copies nobody frees. The spliced declaration
				// (cleared from the scope frames below) is the transfer proof.
				const returned_var =
					node.value.node_type === "value" ? (node.value as ValueNode).value : "";
				const returned_is_local =
					returned_var !== "" &&
					returned_var !== "0" &&
					returned_var !== "null" &&
					all_scope_frames(status)
						.flat()
						.some((d) => d.name === returned_var);
				const bare_local_return = returned_is_local;
				// STRUCT_PLAN_3 B1 cutover: an OWNING struct's string fields
				// are uniformly heap (the ctor strdup'd the seed, stores
				// strdup non-heap RHS, load_T strdups slot copies) — the bare
				// local's bytes transfer raw and the caller's destroy frees
				// them; a strdup here would orphan the donor's heap copy.
				if (bare_local_return && !owns_strings_uniformly(ret_struct)) {
					let skip_fields: Set<string> | undefined;
					const prefix = `${(node.value as ValueNode).value}.`;
					for (const key of status.heap_string_fields ?? []) {
						if (key.startsWith(prefix)) {
							skip_fields ??= new Set<string>();
							skip_fields.add(key.slice(prefix.length));
						}
					}
					emit_string_field_strdups_at(status, ret_struct.name, "x8", 0, skip_fields);
				}
				// Struct-CONSTRUCTOR RETURN normalization (`return R(a, b)`, and
				// the override-constructor form
				// `return [ .. R(a), f = v ]`): strdup every string field the
				// caller would otherwise free as rodata / dangle after the
				// argument's reclaim. Arguments that already own heap transfer
				// raw. For the override form the overrides were applied to the
				// temp above (raw pair stores), so an overridden field holds
				// the OVERRIDE value's pair and follows ITS ownership.
				if (
					node.value?.node_type === "func_call" &&
					(node.value as FunctionCallNode).name === ret_struct.name &&
					!ret_struct.name.startsWith("_")
				) {
					const call = node.value as FunctionCallNode;
					// STRUCT_PLAN_3 B1 cutover: an OWNING struct's ctor strdup'd
					// every string seed AND the construction-temp override store
					// takes the typed lowering (owning_temp_carrier — the
					// override value is strdup'd at the temp), so EVERY string
					// field is uniformly heap here and transfers raw. (C's
					// `_return_val` override stores stay RAW — its return arm
					// keeps the per-field ownership analysis.)
					const mv = owns_strings_uniformly(ret_struct);
					const skip_fields = mv
						? new Set(direct_string_fields(ret_struct).map((f) => f.name))
						: call.field_overrides?.length
							? override_return_string_fields(
									ret_struct,
									call.field_overrides,
									status.heap_strings,
									{
										base_skip: ctor_return_owned_string_fields(
											ret_struct,
											call,
											status.heap_strings,
										),
									},
								)
							: ctor_return_owned_string_fields(ret_struct, call, status.heap_strings);
					emit_string_field_strdups_at(status, ret_struct.name, "x8", 0, skip_fields);
				}
				// FORWARDED normalizing base with overrides, in both checked
				// shapes: `return [ .. make(), f = v ]` as a base-bearing
				// anonymous struct literal (non-ctor bases are not rewritten),
				// or as a rewritten func_call with `field_overrides`. The
				// base's string fields arrived uniformly heap-owned (transfer
				// raw); an overridden field is strdup'd unless the override
				// value owns heap.
				{
					const anon =
						node.value?.node_type === "anon_struct" ? (node.value as AnonStructNode) : undefined;
					const forwarded_base =
						node.value?.node_type === "func_call" &&
						(node.value as FunctionCallNode).field_overrides?.length
							? node.value
							: anon?.base && anon.base.node_type === "func_call"
								? anon.base
								: undefined;
					if (
						forwarded_base &&
						(node.value as FunctionCallNode).name !== ret_struct.name &&
						is_normalized_struct_call(forwarded_base, status)
					) {
						const overrides = anon ? anon.fields : (node.value as FunctionCallNode).field_overrides;
						const skip_fields = override_return_string_fields(
							ret_struct,
							overrides,
							status.heap_strings,
							{ base_uniformly_owned: true },
						);
						emit_string_field_strdups_at(status, ret_struct.name, "x8", 0, skip_fields);
					}
				}
				// Tuple-literal RETURN normalization (mirror of the C
				// backend): `return [a, b]` (the literal is now a `_Tuple_`
				// constructor call) hands the caller a tuple whose STRING
				// fields are uniformly heap-owned, so the caller's
				// destructured bindings can take ownership without a
				// per-element heap check across the call. Elements that
				// already own heap (a transferred heap local, a fresh
				// non-borrow expression) stay raw; everything else — string
				// literals, rodata or non-transferred locals, parameters,
				// borrow accessors — is strdup'd in place on the sret buffer.
				if (
					node.value?.node_type === "func_call" &&
					String((node.value as FunctionCallNode).name ?? "").startsWith("_Tuple_") &&
					(node.value as FunctionCallNode).type?.name?.startsWith("_Tuple_")
				) {
					const tuple_call = node.value as FunctionCallNode;
					const skip_fields = new Set<string>();
					for (const field of direct_string_fields(ret_struct)) {
						const idx = parseInt(field.name.replace(/^_/, ""), 10);
						const element = tuple_call.params[idx];
						if (element && tuple_return_owned_element(element, status.heap_strings)) {
							skip_fields.add(field.name);
						}
					}
					emit_string_field_strdups_at(status, ret_struct.name, "x8", 0, skip_fields);
				}
			}
		}
	}

	if (status.return_assign) {
		ensure_newline(status);
		const size = status.return_assign_size ?? find_var_size(status.return_assign, status);
		emit_var_store(status, "x0", status.return_assign, size);
	} else if (status.function_return_label) {
		ensure_newline(status);

		const return_type = status.function_return_type;
		if (return_type?.is_array) {
			const struct_element = status.structs.find(
				(s) => s.name === return_type.name && !s.is_simple_type,
			);
			const element_size = struct_element
				? struct_element.is_class
					? 8
					: get_struct_size(return_type.name, status)
				: aarch64_size(return_type.name);
			const var_name =
				array_literal_len > 0
					? "_return_array"
					: node.value?.node_type === "value"
						? (node.value as any).value
						: undefined;
			const decl =
				var_name && array_literal_len === 0
					? status.scoped_declarations?.find((d) => d.name === var_name)
					: undefined;
			const array_len =
				array_literal_len > 0
					? array_literal_len
					: decl?.value?.node_type === "array"
						? (decl.value as any).values.length
						: decl?.type?.length
							? parseInt((decl.type.length as any).value || "0")
							: 0;
			if (array_literal_len > 0 && !status.stack_offsets?.has("_return_array")) {
				if (!status.stack_offsets) status.stack_offsets = new Map();
				status.stack_offsets.set("_return_array", array_literal_offset);
			}
			const total_size = array_len * element_size;
			if (total_size > 0) {
				emit_asm(status, `str x0, [sp, #-16]!\n`);
				emit_asm(status, `mov x0, #${8 + total_size}\n`);
				emit_malloc(status);
				emit_asm(status, `mov x1, x0\n`);
				emit_asm(status, `mov x2, #${array_len}\n`);
				emit_asm(status, `str x2, [x1]\n`);
				emit_asm(status, `add x1, x1, #8\n`);
				emit_asm(status, `ldr x2, [sp]\n`);
				const words = Math.ceil(total_size / 8);
				for (let i = 0; i < words; i++) {
					emit_asm(status, `ldr x3, [x2, #${i * 8}]\n`);
					emit_asm(status, `str x3, [x1, #${i * 8}]\n`);
				}
				emit_asm(status, `add sp, sp, #16\n`);
			}
			if (struct_element?.is_class && var_name) {
				if (!status.moved) status.moved = new Set();
				const offset = status.stack_offsets?.get(var_name) ?? 0;
				for (let i = 0; i < array_len; i++) {
					const anchor_name = `${var_name}_elem_${offset + i * element_size}`;
					status.moved.add(anchor_name);
				}
			}
			// Returning a heap-array VARIABLE (`return dst` where dst is a
			// heap-allocated `Array<T>` from `Array.with(...)`, a call, etc.)
			// transfers buffer ownership to the caller. Mark it moved so the
			// return-path cleanup AND the function's fall-through scope-exit
			// cleanup both skip it — otherwise the buffer is freed while the
			// caller still holds the pointer (a use-after-free that is dead
			// code for an unconditional return but a real double-free for a
			// conditional `if cond { return dst }`). Stack-array / literal
			// returns take the heap-alloc-and-copy path above (total_size > 0)
			// and are unaffected.
			if (var_name && status.heap_array_vars?.has(var_name)) {
				if (!status.moved) status.moved = new Set();
				status.moved.add(var_name);
			}
		}

		mark_moved_if_struct(node.value, status, { for_return: true });
		// A returned value struct's bytes — including its string-field
		// pointers — transfer to the caller via the sret copy: the return
		// cleanup below must NOT free the recorded heap string fields (and
		// emit_destroy_for_decl skips moved decls entirely, so the records
		// have to go).
		if (node.value?.node_type === "value") {
			clear_heap_string_fields(status, (node.value as ValueNode).value);
		}
		// Returning a func-typed local closure transfers the descriptor to the
		// caller (which frees it via the scope-exit free-if-owned arm); mark it
		// moved so the callee's return cleanup doesn't double-free it
		// (CLOSURE.md Phase 2c).
		if (node.value?.node_type === "value") {
			const ret_name = (node.value as ValueNode).value;
			const ret_decl = all_scope_frames(status)
				.flat()
				.find((d) => d.name === ret_name && d.type?.name === "func");
			if (ret_decl) {
				if (!status.moved) status.moved = new Set();
				status.moved.add(ret_name);
			}
		}
		const finalized = status.moved ?? new Set<string>();
		// A string return rides the (x0, x1) pair — save BOTH halves around
		// the cleanup calls (destroy clobbers x1). A float return rides d0.
		const returns_fat_pair = current_return_is_string(status);
		const returns_float = current_return_is_float(status);
		if (returns_fat_pair) {
			emit_asm(status, `stp x0, x1, [sp, #-16]!\n`);
		} else if (returns_float) {
			emit_asm(status, `str d0, [sp, #-16]!\n`);
		} else {
			emit_asm(status, `str x0, [sp, #-16]!\n`);
		}
		// The return value is parked on the stack — route through every
		// enclosing nursery's join BEFORE the scope-exit destroys (the
		// structured-concurrency contract: a task may hold pointers into
		// block-scoped resources). The join's `bl`s clobber x0/x1 — the
		// parked copy is what reaches the epilogue.
		emit_nursery_joins_on_return_a64(status);
		for (const decl of all_scope_frames(status).flat()) {
			if (finalized.has(decl.name)) {
				// A moved-out value struct still owns its recorded heap string
				// fields (store_T deep-copied them) — release them here since
				// the skip below bypasses emit_destroy_for_decl. Its
				// enum-with-data fields transfer with the blob (a variable
				// return's sret copy is bitwise), so they are deliberately NOT
				// freed here — the caller now owns them. An owning mv struct
				// whose move was CONDITIONAL keeps its destroy live on the
				// not-moved path, guarded on its runtime moved flag.
				emit_moved_local_cleanup(status, decl);
				continue;
			}
			if (is_field_struct_borrow(decl)) continue;
			emit_destroy_for_decl(
				status,
				decl.name,
				decl.type.name,
				undefined,
				decl.type.type_args,
				decl.type.is_nullable,
			);
		}
		emit_heap_slots_cleanup_for_return(status);
		if (returns_fat_pair) {
			emit_asm(status, `ldp x0, x1, [sp], #16\n`);
		} else if (returns_float) {
			emit_asm(status, `ldr d0, [sp], #16\n`);
		} else {
			emit_asm(status, `ldr x0, [sp], #16\n`);
		}
		emit_asm(status, `b ${status.function_return_label}\n`);
	}
}
