import type BuildStatus from "../build_c/BuildStatus.ts";
import string_literal_length from "../build_common/string_literal_length.ts";
import {
	collect_expression_branch_values,
	is_container_borrow_access,
	is_owned_string_branch_value,
} from "../build_common/string_return_analysis.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { resolve_static_value } from "./build_array_values_node.ts";
import { emit_string_array_labels, resolve_array_element } from "./build_declaration_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_malloc, emit_strdup } from "./utils/audit.ts";
import {
	all_scope_frames,
	clear_heap_string_fields,
	emit_destroy_for_decl,
	emit_heap_slots_cleanup_for_return,
	is_field_struct_borrow,
	mark_moved_if_struct,
	release_heap_string_fields,
} from "./utils/auto_destroy.ts";
import { is_nullable_struct_type } from "./utils/nullable_struct.ts";
import { allocate_stack_space, emit_var_address, emit_var_store } from "./utils/stack_var.ts";
import { emit_strdup_string } from "./utils/string_pair.ts";
import { emit_struct_copy, get_struct_size } from "./utils/struct_layout.ts";

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
	if (rt) return rt.name === "string" && !rt.is_view;
	if (status.current_struct && status.current_function_name) {
		const fn = status.current_struct.functions.find((f) => f.name === status.current_function_name);
		const frt = fn?.return_type;
		return !!frt && frt.name === "string" && !frt.is_view;
	}
	return false;
}

/**
 * Whether the function currently being built declares `mov out string` (the
 * signature-level ownership contract). Mirrors current_return_is_string's
 * resolution: `function_return_type` is unset for primitive-returning struct
 * methods, so resolve the FunctionNode from `current_struct`.
 */
function current_function_returns_mov_string(status: BuildStatus): boolean {
	if (!status.current_struct || !status.current_function_name) return false;
	const fn = status.current_struct.functions.find((f) => f.name === status.current_function_name);
	return !!fn?.returns_mov && fn.return_type?.name === "string" && !fn.return_type?.is_view;
}

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
	if (node.from_inline) {
		return;
	}

	// For a nullable struct return type, the sret buffer (x8) is sized
	// `struct_size + 8`: bytes [0..struct_size] hold the struct value, the
	// 8-byte word at [struct_size] is the companion `_has` flag (0 = null,
	// 1 = value). The callee writes BOTH through x8 — the caller's local is
	// laid out the same way, so the sret writes land directly on the local's
	// value+flag (no extra copy or hardcoded flag at the call site).
	const returns_nullable_struct = is_nullable_struct_type(status.function_return_type, status);
	const nullable_ret_is_null =
		returns_nullable_struct &&
		(!node.value ||
			(node.value.node_type === "value" && (node.value as ValueNode).value === "null"));
	if (nullable_ret_is_null) {
		// `return null`: write 0 to the flag slot in the sret buffer (the
		// struct value is left uninitialised — the caller won't read it).
		if (status.return_buffer_stack_offset !== undefined) {
			const struct_size = get_struct_size(status.function_return_type!.name, status);
			status.code += `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`;
			status.code += `str xzr, [x8, #${struct_size}]\n`;
		}
		// Run scope-exit cleanup for remaining declarations and jump to the
		// return epilogue (mirrors the void-return path above).
		const finalized = status.moved ?? new Set<string>();
		// A return exits every enclosing scope, not just the innermost frame —
		// clean declarations from all of them (all_scope_frames).
		for (const decl of all_scope_frames(status).flat()) {
			if (finalized.has(decl.name)) {
				// A moved-out value struct still owns its recorded heap string
				// fields (store_T deep-copied them) — release them here since
				// the skip below bypasses emit_destroy_for_decl.
				release_heap_string_fields(status, decl.name, decl.type.name);
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
		status.code += `b ${status.function_return_label}\n`;
		return;
	}

	if (!node.value) {
		if (status.return_assign) {
			const size = find_var_size(status.return_assign, status);
			status.code += `mov x0, #0\n`;
			emit_var_store(status, "x0", status.return_assign, size);
		} else if (status.function_return_label) {
			const finalized = status.moved ?? new Set<string>();
			for (const decl of all_scope_frames(status).flat()) {
				if (finalized.has(decl.name)) {
					// A moved-out value struct still owns its recorded heap string
					// fields (store_T deep-copied them) — release them here since
					// the skip below bypasses emit_destroy_for_decl.
					release_heap_string_fields(status, decl.name, decl.type.name);
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
			status.code += `mov x0, #0\n`;
			status.code += `b ${status.function_return_label}\n`;
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
		status.code += `mov x0, #${array_literal_len}\n`;
		status.code += `str x0, [x29, #${start}]\n`;
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
				status.code += `adr x0, ${label}\n`;
				emit_strdup(status);
				status.code += `mov x1, #${string_literal_length(raw)}\n`;
				status.code += `stp x0, x1, [x29, #${slot}]\n`;
			} else if (raw !== null) {
				status.code += `mov x0, #${raw}\n`;
				if (element_size === 1) {
					status.code += `strb w0, [x29, #${slot}]\n`;
				} else if (element_size === 4) {
					status.code += `str w0, [x29, #${slot}]\n`;
				} else {
					status.code += `str x0, [x29, #${slot}]\n`;
				}
			} else {
				build_node(value, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				status.code += `str x0, [x29, #${slot}]\n`;
			}
		});
	}

	let return_join_owned_string = false;
	if (array_literal_len > 0) {
		status.code += `add x0, x29, #${array_literal_offset}\n`;
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
		const old_join_owned = status.join_needs_owned_string;
		status.return_assign = slot_name;
		if (return_join_owned_string) status.join_needs_owned_string = true;
		build_node(node.value, status);
		status.join_needs_owned_string = old_join_owned;
		status.return_assign = old_return_assign;
		// Reload the chosen branch's value from the slot (x0 was clobbered by
		// the branch scope-exit cleanup) and hand the owned result to the
		// caller as-is.
		status.code += `ldr x0, [x29, #${slot}]\n`;
		if (return_join_owned_string) {
			status.last_result_is_heap = true;
		}
	} else {
		// `return T(...) + [ ... ]`: the constructor would normally write
		// straight into the return buffer (struct_return_buffer), bypassing
		// the temp where field overrides are applied. Force the temp path for
		// override constructors so the overrides land on the temp, then the
		// copy below (x0 → return buffer) carries them through.
		const override_ctor =
			node.value?.node_type === "func_call" &&
			!!(node.value as FunctionCallNode).field_overrides?.length;
		const saved_buffer = override_ctor ? status.struct_return_buffer : undefined;
		if (override_ctor) status.struct_return_buffer = undefined;
		build_node(node.value, status);
		if (override_ctor) status.struct_return_buffer = saved_buffer;
	}
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}

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
		status.function_return_type?.name === "string" &&
		!status.function_return_type?.is_view &&
		node.value.node_type === "value" &&
		(node.value as ValueNode).value.length >= 2 &&
		(node.value as ValueNode).value.startsWith('"') &&
		(node.value as ValueNode).value.endsWith('"')
	) {
		const fn_name = status.current_function_name;
		const mangled = status.current_struct ? `${status.current_struct.name}_${fn_name}` : fn_name;
		if (
			fn_name &&
			((!!status.heap_returning_functions &&
				(status.heap_returning_functions.has(fn_name) ||
					(mangled !== undefined && status.heap_returning_functions.has(mangled)))) ||
				// A `mov out string` function hands the caller an OWNED value by
				// signature — a literal return path must be copied into heap
				// storage or the caller frees rodata.
				current_function_returns_mov_string(status))
		) {
			// strdup the ptr half, keep the len half (x1 survives the call).
			emit_strdup_string(status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
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
	// as a non-owned borrow and never free it (mirroring the C backend's
	// `is_string_borrow`), so a copy would hand those callers a heap
	// allocation they never free.
	const borrow_fn_name = status.current_function_name;
	const borrow_mangled =
		status.current_struct && borrow_fn_name
			? `${status.current_struct.name}_${borrow_fn_name}`
			: undefined;
	const normalizes_borrow_returns =
		!!borrow_fn_name &&
		borrow_fn_name !== "at" &&
		borrow_fn_name !== "first" &&
		current_return_is_string(status) &&
		// Either the function is classified heap-returning (its callers free
		// every result) or it declares `mov out string` (the caller owns the
		// result by signature) — in both cases every return path must hand
		// over a heap pointer.
		((!!status.heap_returning_functions &&
			(status.heap_returning_functions.has(borrow_fn_name) ||
				(borrow_mangled !== undefined && status.heap_returning_functions.has(borrow_mangled)))) ||
			current_function_returns_mov_string(status));
	let needs_borrow_strdup = false;
	if (normalizes_borrow_returns) {
		if (node.value.node_type === "value") {
			const raw_value = (node.value as ValueNode).value;
			const is_str_lit =
				raw_value.length >= 2 && raw_value.startsWith('"') && raw_value.endsWith('"');
			const is_numeric = /^(\+|-)?\d+$/.test(raw_value);
			// A bare VARIABLE whose current value is not a heap allocation
			// owned by this frame (not in heap_strings) holds a borrow — copy
			// it. String literals are excluded (handled above) and numerics
			// are excluded (`return 0` hands the caller NULL, which free
			// tolerates). A var in heap_strings transfers ownership directly
			// (mark_moved_if_struct below skips its scope-exit free).
			if (!is_str_lit && !is_numeric && !status.heap_strings?.has(raw_value)) {
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
		emit_strdup_string(status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.last_result_is_heap = true;
	}

	// A `move_T` result returned from a string-returning function (e.g.
	// `List<string>.pop`'s `return self.items.move_T(idx)`) relinquishes a
	// `Buffer<string>` slot. The slot owns an independent heap copy (store_T
	// strdup's), so the returned `char*` is already a heap pointer — it is
	// handed to the caller as-is, NO strdup. Mark the function heap-returning
	// so the caller frees the result. (When slots held shallow borrows, the
	// slot could be rodata and a return-site strdup was required; owning slots
	// make it redundant and a leak.)
	//
	// `function_return_type` is only populated for struct (sret) returns, so
	// for a struct method returning a primitive (like `string`) we look up the
	// declared return type on the current struct's function instead.
	const move_T_ret_is_string =
		node.value.node_type === "access" &&
		(node.value as AccessNode).access.node_type === "access_func" &&
		(node.value as AccessNode).access.name === "move_T" &&
		current_return_is_string(status);
	if (move_T_ret_is_string) {
		status.last_result_is_heap = true;
	}

	if (status.last_result_is_heap && current_return_is_string(status)) {
		if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
		if (status.current_function_name) {
			status.heap_returning_functions.add(status.current_function_name);
		}
	}

	if (status.function_return_label && status.struct_return_buffer && status.function_return_type) {
		const ret_struct = status.structs.find(
			(s) => s.name === status.function_return_type!.name && !s.is_simple_type && !s.is_class,
		);
		if (ret_struct) {
			if (status.return_buffer_stack_offset !== undefined) {
				status.code += `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`;
			}
			const struct_size = get_struct_size(status.function_return_type!.name, status);
			if (node.value.node_type === "value") {
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
			// For a nullable struct return, the sret buffer is sized
			// `struct_size + 8` and the 8-byte word at [struct_size] is the
			// companion `_has` flag. We've just copied the non-null value —
			// write `1` so the caller sees the result as non-null. (The
			// null-return path is handled at the top of this function.)
			if (returns_nullable_struct) {
				status.code += `mov x9, #1\n`;
				status.code += `str x9, [x8, #${struct_size}]\n`;
			}
		}
	}

	if (status.return_assign) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const size = find_var_size(status.return_assign, status);
		emit_var_store(status, "x0", status.return_assign, size);
	} else if (status.function_return_label) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}

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
				status.code += `str x0, [sp, #-16]!\n`;
				status.code += `mov x0, #${8 + total_size}\n`;
				emit_malloc(status);
				status.code += `mov x1, x0\n`;
				status.code += `mov x2, #${array_len}\n`;
				status.code += `str x2, [x1]\n`;
				status.code += `add x1, x1, #8\n`;
				status.code += `ldr x2, [sp]\n`;
				const words = Math.ceil(total_size / 8);
				for (let i = 0; i < words; i++) {
					status.code += `ldr x3, [x2, #${i * 8}]\n`;
					status.code += `str x3, [x1, #${i * 8}]\n`;
				}
				status.code += `add sp, sp, #16\n`;
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
		const finalized = status.moved ?? new Set<string>();
		// A string return rides the (x0, x1) pair — save BOTH halves around
		// the cleanup calls (destroy clobbers x1).
		const returns_fat_pair = current_return_is_string(status);
		if (returns_fat_pair) {
			status.code += `stp x0, x1, [sp, #-16]!\n`;
		} else {
			status.code += `str x0, [sp, #-16]!\n`;
		}
		for (const decl of all_scope_frames(status).flat()) {
			if (finalized.has(decl.name)) {
				// A moved-out value struct still owns its recorded heap string
				// fields (store_T deep-copied them) — release them here since
				// the skip below bypasses emit_destroy_for_decl.
				release_heap_string_fields(status, decl.name, decl.type.name);
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
			status.code += `ldp x0, x1, [sp], #16\n`;
		} else {
			status.code += `ldr x0, [sp], #16\n`;
		}
		status.code += `b ${status.function_return_label}\n`;
	}
}
