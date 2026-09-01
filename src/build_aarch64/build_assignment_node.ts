import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { has_flag_name, is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import { is_float_type } from "../built_in_types.ts";
import { is_int_literal, parse_int_literal_bigint } from "../int_literal.ts";
import type { NirExpr } from "../nir/nir.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import build_node from "./build_node.ts";
import {
	build_float_tree,
	build_int_tree,
	count_int_tree_allocs,
	float_tree_ok,
	INT_TREE_POOL,
	tree_has_call,
	tree_is_call_free,
} from "./build_operation_node.ts";
import { emit_expr_from_nir } from "./emit_nir.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free, emit_strdup } from "./utils/audit.ts";
import {
	anchor_heap_pointer,
	consume_anchor_slot,
	defer_anchor_destroy,
	emit_destroy_for_anchor_slot,
	emit_destroy_for_decl,
	emit_enum_payload_frees,
	find_anchor_slot,
	mark_anchor_destroy,
	mark_moved_if_struct,
	record_heap_string_field,
} from "./utils/auto_destroy.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	emit_var_load,
	emit_var_store,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import {
	emit_struct_copy,
	get_enum_size,
	get_field_has_offset,
	get_field_offset,
	get_struct_size,
} from "./utils/struct_layout.ts";
import { is_view_value } from "./utils/view_value.ts";

function is_mutable_param(name: string, status: BuildStatus): boolean {
	return !!(status.function_param_vars?.has(name) || status.function_ref_params?.has(name));
}

/**
 * Whether `obj.field = rhs` writes a plain `string` field of a struct or
 * class instance. CLASS string fields follow an always-heap-owned convention
 * (see the assignment branch that uses this): `_init` strdup's defaults and
 * assignments strdup non-heap RHS, so destroys can free them unconditionally.
 * VALUE-struct string fields keep per-assignment ownership tracking instead
 * (construction may leave rodata in them): non-heap RHS is strdup'd and the
 * field is recorded in heap_string_fields for release at scope exit.
 * `ref` string fields (borrows) are excluded either way.
 */
function field_is_struct_string(
	target_type: Type | undefined,
	field_type: Type | undefined,
	status: BuildStatus,
): { name: string; target_is_class: boolean } | undefined {
	if (!target_type?.name || !field_type) return undefined;
	// A `view T` field is a non-owning pair — never heap-owned, so it must
	// not enter the strdup/free ownership machinery below.
	if (field_type.is_view) return undefined;
	if (field_type.name !== "string" || field_type.is_ref || field_type.is_array) return undefined;
	const target_struct = status.structs.find(
		(s) => s.name === target_type.name && !s.is_simple_type,
	);
	if (!target_struct) return undefined;
	if (target_struct.is_class) return { name: field_type.name, target_is_class: true };
	return { name: field_type.name, target_is_class: false };
}

/**
 * Load a `ref T` parameter's caller-side pointer into `reg`. The pointer is the
 * 8-byte value held in the parameter's stack slot (or, rarely, a register
 * allocation). Only writes `reg` — safe to run after a RHS has been built into
 * another register, since no caller-saved scratch is touched.
 */
function load_ref_param_pointer(reg: string, name: string, status: BuildStatus) {
	const alloc_reg = status.register_allocations?.get(name);
	if (alloc_reg) {
		status.code += `${alloc_reg.startsWith("d") ? "fmov" : "mov"} ${reg}, ${alloc_reg}\n`;
		return;
	}
	const offset = status.stack_offsets?.get(name);
	if (offset !== undefined) {
		status.code += `ldr ${reg}, [x29, #${offset}]\n`;
		return;
	}
	emit_var_address(status, reg, name);
	status.code += `ldr ${reg}, [${reg}]\n`;
}

function get_store_instruction(size: number): string {
	if (size === 1) return "strb";
	if (size === 2) return "strh";
	if (size === 4) return "str";
	return "str";
}

function get_store_reg(reg: string, size: number): string {
	if (size === 1 || size === 2 || size === 4) return reg.replace("x", "w");
	return reg;
}

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations.find((d) => d.name === name);
	if (decl) return aarch64_size(decl.type.name);
	// Inside a loop body the scoped-declaration table is swapped out — fall
	// back to the checker's persistent variable types (e.g. a string concat
	// reassignment `s = s + …` in a while loop must resolve to the 16-byte
	// fat slot, or only the ptr half would be stored).
	const vt = status.variable_types?.get(name);
	if (vt) return aarch64_size(vt.name);
	return 8;
}

function get_load_instruction(size: number): string {
	if (size === 1) return "ldrb";
	if (size === 2) return "ldrh";
	if (size === 4) return "ldr";
	return "ldr";
}

function get_load_reg(reg: string, size: number): string {
	if (size === 1 || size === 2 || size === 4) return reg.replace("x", "w");
	return reg;
}

/** Emit the combine step of a compound assignment (`n += 1`). Operands
 *  arrive as raw bit patterns (old value in x1, RHS in x0). For float
 *  targets the bit patterns must be combined with FP instructions — an
 *  integer `add`/`sub`/`mul` on double bits produces garbage (e.g.
 *  `x += 1.0` yielding nan). Result returns in x0, preserving the
 *  integer-convention interface used by every call site. */
/** Whether building this RHS provably leaves x1 (and x2) untouched, so a
 *  compound assignment can keep the old value in x1 across it without the
 *  stack spill/reload. A plain non-string value node (numeric/bool literal
 *  or a plain variable) builds to x0 only; strings use the x0/x1 fat pair
 *  and ref-param reads may route through scratch, so both stay on the slow
 *  path. This is the hot idiom `i += 1` / `total += 0.5`. */
function rhs_preserves_x1(node: AssignmentNode, status: BuildStatus): boolean {
	if (node.right_value.node_type !== "value") return false;
	const v = node.right_value as ValueNode;
	if (v.type?.name === "string" || v.value.startsWith('"')) return false;
	if (status.heap_strings?.has(v.value)) return false;
	if (status.function_ref_params?.has(v.value)) return false;
	return true;
}

function get_base_address(access: AccessNode, status: BuildStatus, reg: string) {
	if (access.target.node_type === "value") {
		const name = (access.target as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			if (paramReg !== reg) {
				status.code += `mov ${reg}, ${paramReg}\n`;
			}
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, reg, name);
		} else {
			emit_var_address(status, reg, name);
		}
	} else {
		emit_address_of(access.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		if (reg !== "x0") {
			status.code += `mov ${reg}, x0\n`;
		}
	}
}

/**
 * Deferred field-write base (ASM_PLAN_2 tranche H follow-up): when the
 * receiver of `obj.field = rhs` lives in a callee-saved param register, the
 * base address needs no push/pop round-trip around the RHS — the register
 * provably survives it (the ABI preserves x19–x28 across calls; inline
 * expansions save/restore what they borrow), so the store re-reads it after
 * the RHS build. The value read is bit-identical to the pre-RHS one.
 * Returns the register, or undefined to keep the emit + push flow.
 */
function deferred_field_base_reg(access: AccessNode, status: BuildStatus): string | undefined {
	if (access.target.node_type !== "value") return undefined;
	const name = (access.target as ValueNode).value;
	if (typeof name !== "string") return undefined;
	const paramReg = status.function_param_regs?.get(name);
	if (!paramReg || !/^x(?:19|2[0-8])$/.test(paramReg)) return undefined;
	return paramReg;
}

function is_struct_type(type: Type | undefined, status: BuildStatus): boolean {
	if (!type?.name) return false;
	return !!status.structs.find((s) => s.name === type.name && !s.is_simple_type);
}

function is_enum_with_data_type(type: Type | undefined, status: BuildStatus): boolean {
	if (!type?.name) return false;
	const e = status.enums.find((e) => e.name === type.name);
	return !!e && !!e.has_associated_data;
}

function get_self_param(node: BaseNode): BaseNode | null {
	if (node.node_type === "access" && (node as AccessNode).access.node_type === "access_func") {
		return (node as AccessNode).target;
	}
	if (node.node_type === "func_call") {
		const fc = node as FunctionCallNode;
		const is_init = fc.name.includes("_init") || fc.name.includes("_new");
		if (fc.params.length > 0 && !is_init) {
			return fc.params[0];
		}
	}
	return null;
}

/** Whether an assignment target is a nullable struct slot. */
function is_nullable_struct_assignment(node: AssignmentNode, status: BuildStatus): boolean {
	if (node.left_value.node_type === "value") {
		const name = (node.left_value as ValueNode).value;
		const decl = status.scoped_declarations.find((d) => d.name === name);
		const t = decl?.type || status.variable_types?.get(name);
		return is_nullable_struct_type(t, status);
	}
	if (
		node.left_value.node_type === "access" &&
		(node.left_value as AccessNode).access.node_type === "access_field"
	) {
		const field_type = (node.left_value as AccessNode).access.type;
		return is_nullable_struct_type(field_type, status);
	}
	return false;
}

/**
 * Build assignment to a nullable struct slot: for `= null`, clear the flag;
 * otherwise copy the value in and set the flag to 1.
 */
/**
 * Emit an assignment RHS. Under NIR-driven emission the lowered `NirExpr`
 * rides in and descends through `emit_expr_from_nir` (the expression seam);
 * without one — or if the lowered expr doesn't carry this exact AST node
 * (from_ast is 1:1, so that can't happen) — it is exactly the historical
 * `build_node(rhs)`. Every semantic decision (reclamation, aliasing, move
 * marks, swap marshalling) stays on the AST node in the builder.
 */
function emit_compound_op(op: string, status: BuildStatus, target_is_float = false) {
	if (target_is_float) {
		status.code += `fmov d1, x1\n`;
		status.code += `fmov d0, x0\n`;
		if (op === "+=") status.code += `fadd d0, d1, d0\n`;
		else if (op === "-=") status.code += `fsub d0, d1, d0\n`;
		else if (op === "*=") status.code += `fmul d0, d1, d0\n`;
		status.code += `fmov x0, d0\n`;
		return;
	}
	if (op === "+=") status.code += `add x0, x1, x0\n`;
	else if (op === "-=") status.code += `sub x0, x1, x0\n`;
	else if (op === "*=") status.code += `mul x0, x1, x0\n`;
}

function emit_rhs_value(rhs: BaseNode, nir: NirExpr | null | undefined, status: BuildStatus): void {
	if (nir && nir.node === rhs) {
		emit_expr_from_nir(nir, status);
		return;
	}
	build_node(rhs, status);
}

/**
 * Emit an assignment/declaration SWAP expression (the replacement value
 * `a = b swap <rep>` / `var X b = mov f swap <rep>`): the expression-seam
 * version of the historical `build_node(swap)`. Both callers normalize the
 * trailing newline immediately after, so the helper does it.
 */
export function emit_swap_value(
	swap: BaseNode,
	nir: NirExpr | null | undefined,
	status: BuildStatus,
): void {
	if (nir && nir.node === swap) {
		emit_expr_from_nir(nir, status);
	} else {
		build_node(swap, status);
	}
	if (!status.code.endsWith("\n")) status.code += "\n";
}

function build_nullable_struct_assignment(
	node: AssignmentNode,
	status: BuildStatus,
	nir_rhs?: NirExpr | null,
) {
	const rhs_is_null =
		node.right_value.node_type === "value" && (node.right_value as ValueNode).value === "null";

	if (node.left_value.node_type === "value") {
		const name = (node.left_value as ValueNode).value;
		const flag_name = has_flag_name(name);
		if (rhs_is_null) {
			emit_var_store(status, "xzr", flag_name, 8);
			return;
		}
		// Build the value (a constructor or another struct value) → address in x0.
		emit_rhs_value(node.right_value, nir_rhs, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		// Copy the struct value into the variable's slot, then set the flag.
		const decl = status.scoped_declarations.find((d) => d.name === name);
		const type_name = decl?.type?.name || status.variable_types?.get(name)?.name || "";
		const struct_size = get_struct_size(type_name, status);
		const dst_offset = status.stack_offsets?.get(name);
		emit_struct_copy("x0", "x29", dst_offset ?? 0, struct_size, status);
		status.code += `mov x9, #1\n`;
		emit_var_store(status, "x9", flag_name, 8);
		return;
	}

	// Field assignment: `obj.field = rhs`
	const access = node.left_value as AccessNode;
	const field_access = access.access as AccessFieldNode;
	const target_type = type_from_value_node(access.target);
	const field_name = field_access.name;
	const type_name = field_access.type?.name || "";
	const field_offset = get_field_offset(target_type.name, field_name, status);
	const has_offset = get_field_has_offset(target_type.name, field_name, status);
	const struct_size = get_struct_size(type_name, status);

	// Resolve the target object's address into x9 (preserved across RHS build).
	get_source_address(access.target, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	status.code += `str x0, [sp, #-16]!\n`;

	if (rhs_is_null) {
		status.code += `ldr x9, [sp], #16\n`;
		status.code += `str xzr, [x9, #${has_offset}]\n`;
		return;
	}

	emit_rhs_value(node.right_value, nir_rhs, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	status.code += `ldr x9, [sp], #16\n`;
	// x0 = source address, x9 = object base. Copy value in, set flag.
	emit_struct_copy("x0", "x9", field_offset, struct_size, status);
	status.code += `mov x0, #1\n`;
	status.code += `str x0, [x9, #${has_offset}]\n`;
}

function build_swap(node: AssignmentNode, status: BuildStatus, nir_swap?: NirExpr | null) {
	if (!node.swap) return;
	const rhs = node.right_value;
	if (rhs.node_type === "access" && (rhs as AccessNode).access.node_type === "access_field") {
		const rhs_access = rhs as AccessNode;
		const rhs_field = (rhs_access.access as AccessFieldNode).name;
		const rhs_target_type = type_from_value_node(rhs_access.target);
		const rhs_offset = get_field_offset(rhs_target_type.name, rhs_field, status);
		// A struct field (e.g. Buffer) needs its bytes struct-copied back in;
		// a class field is a single pointer store.
		const field_type = type_from_value_node(rhs_access.access);
		const field_struct = field_type.name
			? status.structs.find((s) => s.name === field_type.name && !s.is_simple_type)
			: undefined;
		const field_is_struct = !!field_struct && !field_struct.is_class;

		emit_swap_value(node.swap, nir_swap, status);
		status.code += `// swap: store replacement to rhs source field\n`;
		status.code += `str x0, [sp, #-16]!\n`;

		get_source_address(rhs_access.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `ldr x1, [sp], #16\n`;
		if (field_is_struct) {
			const field_size = get_struct_size(field_type!.name, status);
			emit_struct_copy("x1", "x0", rhs_offset, field_size, status);
		} else {
			status.code += `str x1, [x0, #${rhs_offset}]\n`;
		}
	} else if (rhs.node_type === "value") {
		const rhs_value = rhs as ValueNode;
		emit_swap_value(node.swap, nir_swap, status);
		status.code += `// swap: store replacement to rhs variable\n`;
		status.code += `str x0, [sp, #-16]!\n`;
		const rhs_name = rhs_value.value;
		const paramReg = status.function_param_regs?.get(rhs_name);
		if (paramReg) {
			status.code += `mov x0, ${paramReg}\n`;
		} else {
			emit_var_address(status, "x0", rhs_name);
		}
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `ldr x1, [sp], #16\n`;
		// A struct variable needs its bytes struct-copied back in; a class
		// variable is a single pointer store (plus an anchor-slot update).
		const rhs_type = type_from_value_node(rhs);
		const rhs_struct = rhs_type.name
			? status.structs.find((s) => s.name === rhs_type.name && !s.is_simple_type)
			: undefined;
		if (rhs_struct && !rhs_struct.is_class) {
			const rhs_size = get_struct_size(rhs_type.name, status);
			emit_struct_copy("x1", "x0", 0, rhs_size, status);
		} else {
			status.code += `str x1, [x0]\n`;
			const rhs_anchor = find_anchor_slot(status, rhs_name);
			if (rhs_anchor !== undefined) {
				status.code += `str x1, [x29, #${rhs_anchor}]\n`;
			}
		}
		status.moved?.delete(rhs_name);
	}
}

/**
 * Resolve the ADDRESS of `value` into x0. A plain name resolves from its
 * slot/param register directly; any other expression is a VALUE emission in
 * address position — under NIR-driven emission the lowered `NirExpr` rides
 * in and descends through the expression seam, exactly the historical
 * `build_node(value)` + newline tail otherwise.
 */
export function get_source_address(value: BaseNode, status: BuildStatus, nir?: NirExpr | null) {
	if (value.node_type === "value") {
		const name = (value as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			status.code += `mov x0, ${paramReg}\n`;
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x0", name);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else if (nir && nir.node === value) {
		emit_expr_from_nir(nir, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	} else {
		build_node(value, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}
}

export default function build_assignment_node(
	node: AssignmentNode,
	status: BuildStatus,
	nir_rhs?: NirExpr | null,
	nir_swap?: NirExpr | null,
) {
	const rhs_type = type_from_value_node(node.right_value);
	const rhs_is_struct = is_struct_type(rhs_type, status);
	// An enum with associated data is multi-word (tag + payload) and lives on
	// the stack like a struct: assignment must struct-copy the whole value,
	// not just store a pointer. Treat it as a struct for assignment purposes.
	const rhs_is_enum_with_data = is_enum_with_data_type(rhs_type, status);

	// Invalidate any cached Buffer.data pointer for the assigned target. A
	// whole-buffer (or buffer-field) reassignment gives the name a new backing
	// store, so a previously cached data pointer would be stale. The cache key
	// mirrors buf_cache_key() in build_access_node (simple name or "obj.field").
	//
	// This also covers `mov self.fld swap X` swaps: the swapped-OUT field is the
	// assignment's RHS (e.g. `self.keys` in `var old = mov self.keys swap ...`),
	// and the swap stores the replacement into it — so that field's buffer (and
	// its cached data pointer) is reassigned. Invalidating the RHS field key is
	// what keeps field-buffer caching sound across Map.rehash and friends.
	if (status.buffer_data_cache) {
		const keys_to_invalidate: string[] = [];
		for (const side of [node.left_value, node.right_value]) {
			if (side.node_type === "value") {
				keys_to_invalidate.push((side as ValueNode).value);
			} else if (
				side.node_type === "access" &&
				(side as AccessNode).access.node_type === "access_field" &&
				(side as AccessNode).target.node_type === "value"
			) {
				const inner = side as AccessNode;
				keys_to_invalidate.push(
					`${(inner.target as ValueNode).value}.${(inner.access as AccessFieldNode).name}`,
				);
			}
		}
		for (const k of keys_to_invalidate) {
			status.buffer_data_cache.delete(k);
		}
	}

	// Assignment to a nullable struct slot (local var or struct field): copy
	// the value in (if non-null) and set the companion `_has` flag.
	if (!node.operator && is_nullable_struct_assignment(node, status)) {
		build_nullable_struct_assignment(node, status, nir_rhs);
		build_swap(node, status, nir_swap);
		return;
	}

	if (node.left_value.node_type === "value") {
		const name = (node.left_value as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);

		if (rhs_is_struct && !node.operator) {
			const struct_size = get_struct_size(rhs_type.name, status);
			const rhs_struct = status.structs.find((s) => s.name === rhs_type.name && s.is_class);
			if (rhs_struct && node.right_value.node_type === "func_call") {
				const func_call = node.right_value as import("../nodes/FunctionCallNode.ts").default;
				const is_constructor = status.structs.find(
					(s) => s.name === func_call.name && !s.is_simple_type,
				);
				if (is_constructor) {
					const is_alias = !!status.class_alias_vars?.has(name);
					// A trait-typed class local (`var Speaker s = Dog(); s = Cat()`)
					// reclaims its old instance via the trait's `<Trait>_destroy`
					// shim — the concrete type at runtime may differ from the
					// initializer's after a prior reassignment — then builds the
					// replacement and re-anchors it tagged with the trait name so
					// every later cleanup path dispatches destroy polymorphically.
					const trait_class_trait = status.trait_class_locals?.get(name);
					if (trait_class_trait !== undefined) {
						const decl_frame = status.class_decl_frame?.get(name);
						consume_anchor_slot(status, name);
						if (!status.moved?.has(name)) {
							const label_id = (status.label_counter = (status.label_counter ?? 0) + 1);
							const no_free_label = `.Ltrait_no_free_${label_id}`;
							emit_var_load(status, "x0", name, 8);
							status.code += `cbz x0, ${no_free_label}\n`;
							status.code += `bl ${trait_class_trait}_destroy\n`;
							emit_var_load(status, "x0", name, 8);
							emit_free(status);
							status.code += `${no_free_label}:\n`;
						}
						mark_moved_if_struct(node.right_value, status);
						status.moved?.delete(name);
						emit_rhs_value(node.right_value, nir_rhs, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						anchor_heap_pointer(status, name, decl_frame);
						mark_anchor_destroy(status, name, trait_class_trait);
						const offset = status.stack_offsets?.get(name);
						if (offset !== undefined) {
							status.code += `str x0, [x29, #${offset}]\n`;
						}
						build_swap(node, status, nir_swap);
						return;
					}
					// Does this variable own its current instance (have an anchor
					// slot)? Owners always do; an object-level alias only does so
					// after a previous reassignment gave it one (its initial value
					// is shared with the original owner and must NOT be freed).
					const owns_current = find_anchor_slot(status, name) !== undefined;
					const decl_frame = status.class_decl_frame?.get(name);
					// A `ref` class param's callee-saved register holds the
					// instance (loaded at function entry); the ADDRESS of the
					// caller's pointer slot is kept in ref_class_slots. Reassignment
					// transfers the caller's ownership: destroy+free the caller's
					// current instance, build the replacement, and store its pointer
					// back through that slot. The replacement belongs to the caller
					// — its anchor is synced at the call site — so it must NOT be
					// anchored or freed in this frame.
					const ref_slot = status.ref_class_slots?.get(name);
					if (ref_slot !== undefined) {
						const tmp = allocate_stack_space(status, 8, 8);
						status.code += `ldr x1, [x29, #${ref_slot}]\n`;
						status.code += `ldr x0, [x1]\n`;
						status.code += `str x0, [x29, #${tmp}]\n`;
						emit_destroy_for_anchor_slot(
							status,
							tmp,
							rhs_type.name,
							rhs_type.type_args,
							rhs_type.is_nullable,
						);
						status.code += `ldr x0, [x29, #${tmp}]\n`;
						emit_free(status);
						mark_moved_if_struct(node.right_value, status);
						emit_rhs_value(node.right_value, nir_rhs, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						status.code += `ldr x1, [x29, #${ref_slot}]\n`;
						status.code += `str x0, [x1]\n`;
						if (paramReg) {
							status.code += `mov ${paramReg}, x0\n`;
						}
						build_swap(node, status, nir_swap);
						return;
					}
					if (node.has_live_borrow) {
						// A live field/method borrow references the current
						// instance, so keep it alive (deferred reclamation) until
						// the borrow's scope ends. Disown the anchor (freed at
						// exit) and anchor the replacement in the declaration
						// frame so it survives nested scopes.
						if (owns_current) {
							defer_anchor_destroy(status, name, rhs_type.name, rhs_type.type_args);
						}
						mark_moved_if_struct(node.right_value, status);
						emit_rhs_value(node.right_value, nir_rhs, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						anchor_heap_pointer(status, name, decl_frame);
						if (is_alias) {
							mark_anchor_destroy(status, name, rhs_type.name, rhs_type.type_args);
						}
						const offset = status.stack_offsets?.get(name);
						if (offset !== undefined) {
							status.code += `str x0, [x29, #${offset}]\n`;
						}
						build_swap(node, status, nir_swap);
						return;
					}
					// No live borrow: reclaim the current instance eagerly. This
					// is what makes reassignment sound inside a loop — the
					// emitted code frees the current instance every iteration
					// instead of deferring to a single scope-exit slot that gets
					// overwritten. Owners always own their current value. An
					// object-level alias only owns its value after its first
					// reassignment; the build can't see that statically inside a
					// loop (owns_current is evaluated once, before the alias has
					// an anchor), so it decides at runtime via the alias ownership
					// flag — freeing the current instance only once the alias has
					// taken ownership (the first reassignment leaves the shared
					// original value for its owner).
					const alias_flag =
						is_alias && !owns_current ? status.alias_owns_flag?.get(name) : undefined;
					// For a nullable class var reassigned in a loop, owns_current is
					// false at build time (no anchor from the null declaration), but
					// at runtime the var may own an instance from a prior iteration.
					// Emit a runtime-guarded reclaim so old instances don't leak.
					// (variable_types persists across the loop body's scope swap.)
					const decl_is_nullable = !!status.variable_types?.get(name)?.is_nullable;
					if (owns_current) {
						consume_anchor_slot(status, name);
						// Skip the reclaim when the var was moved (e.g. `take(mov a)`
						// then `a = Box(...)`) — the callee already freed the old
						// instance, so freeing again here would double-free.
						if (!status.moved?.has(name)) {
							emit_destroy_for_decl(
								status,
								name,
								rhs_type.name,
								undefined,
								rhs_type.type_args,
								rhs_type.is_nullable,
							);
							emit_var_load(status, "x0", name, 8);
							emit_free(status);
						}
					} else if (alias_flag !== undefined) {
						const label_id = (status.label_counter = (status.label_counter ?? 0) + 1);
						const no_free_label = `.Lalias_no_free_${label_id}`;
						status.code += `ldr x9, [x29, #${alias_flag}]\n`;
						status.code += `cbz x9, ${no_free_label}\n`;
						emit_destroy_for_decl(
							status,
							name,
							rhs_type.name,
							undefined,
							rhs_type.type_args,
							rhs_type.is_nullable,
						);
						emit_var_load(status, "x0", name, 8);
						emit_free(status);
						status.code += `${no_free_label}:\n`;
					} else if (decl_is_nullable && !status.moved?.has(name)) {
						const label_id = (status.label_counter = (status.label_counter ?? 0) + 1);
						const no_free_label = `.Lnullable_no_free_${label_id}`;
						emit_var_load(status, "x0", name, 8);
						status.code += `cbz x0, ${no_free_label}\n`;
						emit_destroy_for_decl(status, name, rhs_type.name, undefined, rhs_type.type_args, true);
						emit_var_load(status, "x0", name, 8);
						emit_free(status);
						status.code += `${no_free_label}:\n`;
					}
					mark_moved_if_struct(node.right_value, status);
					// Reassignment gives the variable a new valid value — clear any
					// stale moved flag so scope-exit cleanup frees this instance.
					status.moved?.delete(name);
					emit_rhs_value(node.right_value, nir_rhs, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					anchor_heap_pointer(status, name, decl_frame);
					if (is_alias) {
						mark_anchor_destroy(status, name, rhs_type.name, rhs_type.type_args);
					}
					const offset = status.stack_offsets?.get(name);
					if (offset !== undefined) {
						status.code += `str x0, [x29, #${offset}]\n`;
					}
					if (alias_flag !== undefined) {
						status.code += `mov x9, #1\n`;
						status.code += `str x9, [x29, #${alias_flag}]\n`;
					}
					build_swap(node, status, nir_swap);
					return;
				}
			}
			mark_moved_if_struct(node.right_value, status);
			if (rhs_is_struct && !rhs_struct) {
				const self_param = get_self_param(node.right_value);
				if (self_param && self_param.node_type === "value") {
					const self_name = (self_param as ValueNode).value;
					if (self_name !== name) {
						mark_moved_if_struct(self_param, status);
					}
				}
			}
			const lhs_decl = status.scoped_declarations.find((d) => d.name === name);
			const lhs_type_name = lhs_decl?.type?.name ?? "";
			const needs_pre_destroy =
				rhs_is_struct &&
				!rhs_struct &&
				!paramReg &&
				!is_local_ref_var(name, status) &&
				lhs_type_name;
			if (needs_pre_destroy) {
				emit_destroy_for_decl(
					status,
					name,
					lhs_type_name,
					undefined,
					lhs_decl?.type?.type_args,
					lhs_decl?.type?.is_nullable,
				);
			}
			get_source_address(node.right_value, status, nir_rhs);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			if (paramReg && is_mutable_param(name, status)) {
				if (status.function_ref_params?.has(name)) {
					status.code += `mov ${paramReg}, x0\n`;
				} else {
					status.code += `mov x1, ${paramReg}\n`;
					emit_struct_copy("x0", "x1", 0, struct_size, status);
				}
			} else if (paramReg) {
				status.code += `// cannot assign to const param\n`;
			} else if (is_local_ref_var(name, status)) {
				if (rhs_struct) {
					const anchor = find_anchor_slot(status, name);
					if (anchor !== undefined) {
						const var_offset = status.stack_offsets?.get(name);
						status.code += `str x0, [sp, #-16]!\n`;
						// Destroy the old instance (#destroy + free owned fields)
						// before freeing its memory, so a class with class fields
						// doesn't leak them each reassignment (compounds in a loop).
						emit_destroy_for_anchor_slot(
							status,
							anchor,
							rhs_type.name,
							rhs_type.type_args,
							rhs_type.is_nullable,
						);
						status.code += `ldr x0, [x29, #${anchor}]\n`;
						emit_free(status);
						status.code += `ldr x3, [sp], #16\n`;
						status.code += `str x3, [x29, #${anchor}]\n`;
						if (var_offset !== undefined) {
							status.code += `str x3, [x29, #${var_offset}]\n`;
						} else {
							emit_var_address(status, "x1", name);
							status.code += `str x3, [x1]\n`;
						}
					} else {
						emit_var_address(status, "x1", name);
						status.code += `str x0, [x1]\n`;
					}
				} else {
					emit_var_address(status, "x1", name);
					status.code += `str x0, [x1]\n`;
				}
			} else {
				if (rhs_struct) {
					const anchor = find_anchor_slot(status, name);
					if (anchor !== undefined) {
						const var_offset = status.stack_offsets?.get(name);
						status.code += `str x0, [sp, #-16]!\n`;
						// Run the old instance's #destroy (and free its owned class
						// fields) before freeing its memory — a bare free here would
						// leak the fields every reassignment, which compounds in a
						// loop. emit_destroy_for_anchor_slot loads [anchor] itself.
						emit_destroy_for_anchor_slot(
							status,
							anchor,
							rhs_type.name,
							rhs_type.type_args,
							rhs_type.is_nullable,
						);
						status.code += `ldr x0, [x29, #${anchor}]\n`;
						emit_free(status);
						status.code += `ldr x3, [sp], #16\n`;
						status.code += `str x3, [x29, #${anchor}]\n`;
						if (var_offset !== undefined) {
							status.code += `str x3, [x29, #${var_offset}]\n`;
						} else {
							emit_var_address(status, "x1", name);
							status.code += `str x3, [x1]\n`;
						}
					} else {
						emit_var_address(status, "x1", name);
						emit_struct_copy("x0", "x1", 0, struct_size, status);
					}
				} else {
					emit_var_address(status, "x1", name);
					emit_struct_copy("x0", "x1", 0, struct_size, status);
				}
			}
			build_swap(node, status, nir_swap);
			return;
		}

		// Enum with associated data is multi-word (tag + payload). The RHS
		// builds to a temp address in x0; copy the full enum bytes into the
		// variable's stack slot (a plain `str` would only store the address).
		// Reassignment displaces the old value: free its string payloads
		// (tag-guarded) BEFORE the copy — scope-exit only reclaims the final
		// value, so the displaced payload would otherwise leak.
		if (rhs_is_enum_with_data && !node.operator) {
			const enum_size = get_enum_size(rhs_type.name, status);
			const lhs_enum = status.enums.find((e) => e.name === rhs_type.name);
			if (lhs_enum?.cases.some((c) => c.params.some((p) => p.type.name === "string"))) {
				emit_enum_payload_frees(status, rhs_type.name, name);
			}
			emit_rhs_value(node.right_value, nir_rhs, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			emit_var_address(status, "x1", name);
			emit_struct_copy("x0", "x1", 0, enum_size, status);
			build_swap(node, status, nir_swap);
			return;
		}

		const size = find_var_size(name, status);
		const lhs_decl = status.scoped_declarations.find((d) => d.name === name);
		// Inside a loop body the scoped-declaration table is swapped out (see
		// find_var_size) — fall back to the checker's persistent variable
		// types so a float `x += f` in a loop still lowers to fadd.
		const lhs_type_name = lhs_decl?.type?.name ?? status.variable_types?.get(name)?.name ?? "";
		const store_op = get_store_instruction(size);
		const store_reg = get_store_reg("x0", size);
		if (paramReg) {
			if (is_mutable_param(name, status)) {
				status.code += `mov x2, ${paramReg}\n`;
				emit_rhs_value(node.right_value, nir_rhs, status);
				if (node.operator) {
					// x0 holds the RHS; the old value lands in x1. (The
					// historical `mov x1, x0` here clobbered the old value
					// with the RHS, making `p += r` compute r + r.)
					status.code += `\nstr x0, [sp, #-16]!\n`;
					const load_op = get_load_instruction(size);
					const load_reg = get_load_reg("x1", size);
					status.code += `${load_op} ${load_reg}, [x2]\n`;
					status.code += `str x1, [sp, #-16]!\n`;
					status.code += `ldr x0, [sp], #16\n`;
					status.code += `ldr x1, [sp], #16\n`;
					emit_compound_op(node.operator, status, is_float_type(lhs_type_name));
				}
				status.code += `\n${store_op} ${store_reg}, [x2]\n`;
			} else {
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `\n// cannot assign to const param\n`;
			}
		} else if (status.function_ref_params?.has(name)) {
			const struct_type = status.structs.find((s) => s.name === lhs_type_name && s.is_class);
			if (struct_type && !node.operator && node.right_value.node_type === "func_call") {
				const func_call = node.right_value as import("../nodes/FunctionCallNode.ts").default;
				const is_constructor = status.structs.find(
					(s) => s.name === func_call.name && !s.is_simple_type,
				);
				if (is_constructor) {
					emit_rhs_value(node.right_value, nir_rhs, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					anchor_heap_pointer(status, name);
					const offset = status.stack_offsets?.get(name);
					if (offset !== undefined) {
						status.code += `str x0, [x29, #${offset}]\n`;
					}
					build_swap(node, status, nir_swap);
					return;
				}
			}
			if (struct_type && !node.operator) {
				status.last_result_is_heap = false;
				emit_rhs_value(node.right_value, nir_rhs, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				// Reclaim a nullable class instance being overwritten by a non-
				// constructor RHS (e.g. `a = null` or `a = other_nullable`).
				// The constructor path above handles its own reclamation; this
				// catches the value-typed RHS path that would otherwise just
				// overwrite the slot and leak the old heap instance. Skip the
				// free when the var was moved — the callee already freed it.
				const was_moved = !!status.moved?.has(name);
				if (find_anchor_slot(status, name) !== undefined) {
					status.code += `str x0, [sp, #-16]!\n`;
					if (!was_moved) {
						emit_destroy_for_decl(
							status,
							name,
							lhs_type_name,
							undefined,
							lhs_decl?.type?.type_args,
							lhs_decl?.type?.is_nullable,
						);
						emit_var_load(status, "x0", name, 8);
						emit_free(status);
					}
					consume_anchor_slot(status, name);
					status.code += `ldr x0, [sp], #16\n`;
				}
				// Only anchor when the RHS produced a fresh heap allocation
				// (e.g. a factory function). Borrowed references returned by
				// accessor methods must not be anchored — they are owned
				// elsewhere and anchoring them would cause a double-free.
				if (status.last_result_is_heap) {
					anchor_heap_pointer(status, name);
				}
				const offset = status.stack_offsets?.get(name);
				if (offset !== undefined) {
					status.code += `str x0, [x29, #${offset}]\n`;
				}
				build_swap(node, status, nir_swap);
				return;
			}
			// The caller's pointer is kept in a stack slot (or register) and the
			// pointee may be smaller than 8 bytes (`ref bool` / `ref uint8` / …),
			// so resolve the load/store width from the left value's pointee type
			// rather than `find_var_size` (which only sees scoped_declarations
			// and so returns 8 for every param — writing `str x0` where `strb w0`
			// is needed and clobbering adjacent memory).
			const ref_type_name = (node.left_value as ValueNode).type?.name;
			const ref_size = ref_type_name ? aarch64_size(ref_type_name) : size;
			const ref_store_op = get_store_instruction(ref_size);
			const ref_store_reg = get_store_reg("x0", ref_size);
			if (node.operator) {
				// Compound assignment (`n += 1`): read the current value through
				// the caller's pointer, build the RHS, combine, and store back.
				// The pointer and the old value must survive a complex RHS
				// build, so they are spilled to the stack — build_node freely
				// reuses x1/x2 as scratch. A simple RHS (literal/plain var)
				// touches neither, skipping both spills.
				load_ref_param_pointer("x2", name, status);
				const load_op = get_load_instruction(ref_size);
				const load_reg = get_load_reg("x1", ref_size);
				status.code += `${load_op} ${load_reg}, [x2]\n`;
				const keep = rhs_preserves_x1(node, status);
				if (!keep) {
					status.code += `str x2, [sp, #-16]!\n`;
					status.code += `str x1, [sp, #-16]!\n`;
				}
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `\n`;
				if (!keep) {
					status.code += `ldr x1, [sp], #16\n`;
					status.code += `ldr x2, [sp], #16\n`;
				}
				emit_compound_op(node.operator, status, is_float_type(ref_type_name));
				status.code += `${ref_store_op} ${ref_store_reg}, [x2]\n`;
			} else {
				// Plain assignment. Build the RHS FIRST: its reads of the ref
				// param re-derive the caller's pointer from the stack slot, so
				// no register needs to survive build_node. Parking the pointer
				// in x2 across build_node(rhs) is unsound — the RHS freely
				// reuses x2 as scratch (e.g. the right operand of `+`), so the
				// final store would hit a garbage address.
				status.last_result_is_heap = false;
				emit_rhs_value(node.right_value, nir_rhs, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				// A `ref string` pointee: the write goes through to the
				// CALLER's storage, whose scope-exit ownership tracking
				// (heap_strings) may free it. Storing a non-owning value (a
				// rodata literal, another variable's string) would make that
				// free invalid — strdup it so the caller's slot keeps owning a
				// heap copy. The displaced old value leaks (the callee can't
				// know whether the caller's slot was owned); a fresh-heap RHS
				// (last_result_is_heap) is stored directly. Mirrors the C
				// backend's ref-string-param lowering.
				if (ref_type_name === "string" && !status.last_result_is_heap) {
					emit_strdup(status);
				}
				load_ref_param_pointer("x2", name, status);
				if (ref_size === 16) {
					// Fat string: write BOTH halves through the caller's
					// pointer (ptr at +0, len at +8).
					status.code += `str x0, [x2]\n`;
					status.code += `str x1, [x2, #8]\n`;
				} else {
					status.code += `${ref_store_op} ${ref_store_reg}, [x2]\n`;
				}
			}
		} else if (node.operator) {
			const alloc_reg_op = status.register_allocations?.get(name);
			// Literal-compound fast path (ASM_PLAN_2 tranche F): `x += 1` /
			// `i -= 2` on a promoted x-target folds to one `add/sub xN, xN,
			// #imm` — no x1 round-trip, no spill. Only +/- with immediates
			// the `add imm12` form takes (0..4095); everything else keeps
			// the generic compound sequence below.
			if (alloc_reg_op?.startsWith("x") && (node.operator === "+" || node.operator === "-")) {
				const lit =
					node.right_value.node_type === "value"
						? (node.right_value as ValueNode).value
						: undefined;
				if (lit !== undefined && is_int_literal(lit)) {
					const mag = parse_int_literal_bigint(lit);
					if (mag !== null && mag >= 0n && mag <= 4095n) {
						const mn = node.operator === "+" ? "add" : "sub";
						status.code += `${mn} ${alloc_reg_op}, ${alloc_reg_op}, #${mag.toString()}\n`;
						build_swap(node, status, nir_swap);
						return;
					}
				}
			}
			if (alloc_reg_op) {
				if (alloc_reg_op.startsWith("d")) {
					status.code += `fmov x1, ${alloc_reg_op}\n`;
				} else {
					status.code += `mov x1, ${alloc_reg_op}\n`;
				}
				const keep = rhs_preserves_x1(node, status);
				if (!keep) status.code += `str x1, [sp, #-16]!\n`;
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `\n`;
				if (!keep) status.code += `ldr x1, [sp], #16\n`;
				emit_compound_op(
					node.operator,
					status,
					alloc_reg_op.startsWith("d") || is_float_type(lhs_type_name),
				);
				if (alloc_reg_op.startsWith("d")) {
					status.code += `fmov ${alloc_reg_op}, x0\n`;
				} else {
					status.code += `mov ${alloc_reg_op}, x0\n`;
				}
			} else {
				emit_var_address(status, "x1", name);
				const load_op = get_load_instruction(size);
				const load_reg = get_load_reg("x1", size);
				status.code += `${load_op} ${load_reg}, [x1]\n`;
				const keep = rhs_preserves_x1(node, status);
				if (!keep) status.code += `str x1, [sp, #-16]!\n`;
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `\n`;
				if (!keep) status.code += `ldr x1, [sp], #16\n`;
				emit_compound_op(node.operator, status, is_float_type(lhs_type_name));
				emit_var_address(status, "x1", name);
				status.code += `${store_op} ${store_reg}, [x1]\n`;
			}
		} else {
			const lhs_is_heap = status.heap_strings?.has(name);
			// Fast path: assignment to a register-allocated float var from a
			// float expression. The default assignment codegen builds the RHS
			// into x0 (the float op emitting `fmov x0, d0`) then stores it
			// back into the d-register (`fmov dN, x0`) — a d0→x0→dN round-trip
			// that costs two `fmov` per assignment. By requesting the d0 fast
			// path (`float_result_in_d0`), nested float operations in the RHS
			// leave their result in d0 and we move directly d0→dN (one `fmov`).
			// Non-float-op RHS (variables, literals, function calls, casts)
			// don't consume the flag, so we fall back to the x0 path for them.
			// This is the dominant remaining codegen cost in mandelbrot's
			// mbrot inner loop (4 float assignments per iteration).
			const alloc_reg_fast = status.register_allocations?.get(name);
			if (alloc_reg_fast?.startsWith("d") && !node.operator && !lhs_is_heap) {
				status.last_result_is_heap = false;
				status.float_result_in_d0 = true;
				// Float expression-tree allocation (ASM_PLAN_2 tranche C):
				// call-free trees allocate into the untouched v16-v31 pool
				// with the root landing directly in the target register —
				// no d0/d1 scratch, no spills, no writeback fmov.
				if (alloc_reg_fast !== "d0" && alloc_reg_fast !== "d1" && alloc_reg_fast !== "d2") {
					const seen = new Set<unknown>();
					if (!tree_has_call(node.right_value, seen)) {
						const budget = { n: 14 };
						if (float_tree_ok(node.right_value, budget)) {
							status.float_result_in_d0 = false;
							build_float_tree(node.right_value, alloc_reg_fast, { v: 0 }, status);
							if (!status.code.endsWith("\n")) status.code += "\n";
							build_swap(node, status, nir_swap);
							return;
						}
					}
				}
				// Destination hint (ASM_PLAN_2 tranche C): a float-op RHS
				// root emits directly into the target's register — no d0 +
				// writeback fmov. Scratch-safety guard: the hint is never
				// d0-d2 (the expression scratch registers).
				const hint_ok =
					alloc_reg_fast !== "d0" && alloc_reg_fast !== "d1" && alloc_reg_fast !== "d2";
				if (hint_ok) status.float_dest_hint = alloc_reg_fast;
				emit_rhs_value(node.right_value, nir_rhs, status);
				const hint_consumed = hint_ok && status.float_dest_hint === undefined;
				status.float_dest_hint = undefined;
				if (!status.code.endsWith("\n")) status.code += "\n";
				if (hint_consumed) {
					// The root op already wrote the target register.
				} else if (!status.float_result_in_d0) {
					if (alloc_reg_fast !== "d0") {
						status.code += `fmov ${alloc_reg_fast}, d0\n`;
					}
				} else {
					status.float_result_in_d0 = false;
					status.code += `fmov ${alloc_reg_fast}, x0\n`;
				}
				build_swap(node, status, nir_swap);
				return;
			}
			// Int fast path (ASM_PLAN_2 tranche F): assignment to a promoted
			// x-register target from an integer expression. Two tiers, the
			// analogs of the float tree + hint above:
			// (a) call-free int trees allocate interior results into the
			//     untouched x12-x15 pool with the root landing directly in
			//     the target register;
			// (b) otherwise the root int op emits into the target via
			//     int_dest_hint (callee-saved x23-x28 only — a call inside
			//     the RHS would clobber x12-x15 before the root reads its
			//     sources). Unconsumed hints (leaf/call/cast RHS) fall back
			//     to the x0 writeback mov.
			const alloc_reg_int = status.register_allocations?.get(name);
			if (alloc_reg_int?.startsWith("x") && !node.operator && !lhs_is_heap) {
				status.last_result_is_heap = false;
				const rhs_call_free = tree_is_call_free(node.right_value, status, new Set());
				if (alloc_reg_int !== "x0" && alloc_reg_int !== "x1" && alloc_reg_int !== "x2") {
					if (rhs_call_free) {
						const allocs = count_int_tree_allocs(node.right_value, status);
						if (allocs <= INT_TREE_POOL) {
							build_int_tree(node.right_value, alloc_reg_int, { v: 0 }, status);
							if (!status.code.endsWith("\n")) status.code += "\n";
							build_swap(node, status, nir_swap);
							return;
						}
					}
				}
				// Hint-safe targets: callee-saved always; the caller-saved
				// ext pool only when the RHS itself contains no call (in a
				// call-free loop nothing else can clobber x12-x15 either).
				if (/^x2[3-8]$/.test(alloc_reg_int) || (rhs_call_free && /^x1[2-5]$/.test(alloc_reg_int))) {
					status.int_dest_hint = alloc_reg_int;
				}
				emit_rhs_value(node.right_value, nir_rhs, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				const hint_consumed = status.int_dest_hint === undefined;
				status.int_dest_hint = undefined;
				if (!hint_consumed && alloc_reg_int !== "x0") {
					status.code += `mov ${alloc_reg_int}, x0\n`;
				}
				build_swap(node, status, nir_swap);
				return;
			}
			status.last_result_is_heap = false;
			// Build the RHS first: it may read the current (old) value of `name`
			// (e.g. `s = s + "x"`), so the old value must still be alive here.
			emit_rhs_value(node.right_value, nir_rhs, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			// Preserve the freshly computed value across freeing the old value.
			// A fat string rides the (x0, x1) pair — save BOTH halves.
			const saves_fat_pair = size === 16;
			if (saves_fat_pair) {
				status.code += `stp x0, x1, [sp, #-16]!\n`;
			} else {
				status.code += `str x0, [sp, #-16]!\n`;
			}
			if (lhs_is_heap) {
				emit_var_load(status, "x0", name, 8);
				emit_free(status);
				status.heap_strings!.delete(name);
			}
			if (saves_fat_pair) {
				status.code += `ldp x0, x1, [sp], #16\n`;
			} else {
				status.code += `ldr x0, [sp], #16\n`;
			}
			// last_result_is_heap means the RHS produced a fresh heap string, so the
			// target now owns a heap value. (Don't key off lhs_type_name: inside a
			// loop body the scoped-declaration table is swapped out, so the type
			// can't always be resolved here.)
			if (status.last_result_is_heap) {
				if (!status.heap_strings) status.heap_strings = new Set();
				status.heap_strings.add(name);
			}
			status.code += `\n`;
			emit_var_store(status, "x0", name, size);
		}
	} else if (node.left_value.node_type === "access") {
		const access = node.left_value as AccessNode;
		if (access.access.node_type === "access_field") {
			const field_name = (access.access as AccessFieldNode).name;
			let target_type = type_from_value_node(access.target);
			if (!target_type?.name && access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				if (name === "self" && status.current_struct) {
					target_type = new Type(status.current_struct.name);
				} else if (status.variable_types?.has(name)) {
					target_type = status.variable_types.get(name)!;
				}
			}

			const field_type = (access.access as AccessFieldNode).type;
			const field_is_struct = is_struct_type(field_type, status);

			if (access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				const paramReg = status.function_param_regs?.get(name);
				if (paramReg && name !== "self" && !is_mutable_param(name, status)) {
					status.code += `// cannot assign to field of value param\n`;
					build_swap(node, status, nir_swap);
					return;
				}
			}

			if (field_type?.is_ref) {
				const offset = get_field_offset(target_type.name, field_name, status);

				const base_reg = deferred_field_base_reg(access, status);
				if (base_reg === undefined) {
					get_base_address(access, status, "x0");
					status.code += `str x0, [sp, #-16]!\n`;
				}

				get_source_address(node.right_value, status, nir_rhs);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				if (base_reg !== undefined) {
					status.code += `str x0, [${base_reg}, #${offset}]\n`;
				} else {
					status.code += `mov x2, x0\n`;
					status.code += `ldr x0, [sp], #16\n`;

					status.code += `str x2, [x0, #${offset}]\n`;
				}
			} else if (field_type?.is_view && !node.operator) {
				// A `view T` field store (`line.text = doc.slice(0, 5)`): the
				// field is a non-owning (ptr, len) pair — store both halves
				// verbatim. Nothing is duplicated and the displaced pair owns
				// nothing, so there is no strdup / free / ownership record.
				const offset = get_field_offset(target_type.name, field_name, status);
				get_base_address(access, status, "x0");
				status.code += `str x0, [sp, #-16]!\n`;

				emit_rhs_value(node.right_value, nir_rhs, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				mark_moved_if_struct(node.right_value, status);
				if (field_type.name === "string" || is_view_value(node.right_value, status)) {
					// A fat string / view value builds as the full pair.
					status.code += `stp x0, x1, [sp, #-16]!\n`;
					status.code += `ldp x2, x3, [sp], #16\n`;
					status.code += `ldr x0, [sp], #16\n`;
					status.code += `str x2, [x0, #${offset}]\n`;
					status.code += `str x3, [x0, #${offset + 8}]\n`;
				} else {
					// A scalar RHS has no pair identity: store the value half,
					// zero the length half (an empty slice over that value).
					status.code += `str x0, [sp, #-16]!\n`;
					status.code += `ldr x2, [sp], #16\n`;
					status.code += `ldr x0, [sp], #16\n`;
					status.code += `str x2, [x0, #${offset}]\n`;
					status.code += `str xzr, [x0, #${offset + 8}]\n`;
				}
			} else if (
				field_is_struct_string(target_type, field_type, status) &&
				!node.operator &&
				// Only for CLASS targets (always-heap fields) or a named
				// local/param target whose ownership can be tracked in
				// heap_string_fields. A `self.field = …` write inside a
				// VALUE-struct method (custom #init, trait default) writes
				// through to the caller's storage — strdup'ing here would
				// leave an untracked heap copy (the caller can't know), so it
				// falls through to the plain raw store. Mirrors the C backend
				// (which gates the whole branch on `target_var !== "self"`).
				(() => {
					const st = field_is_struct_string(target_type, field_type, status)!;
					const tv = access.target.node_type === "value" ? (access.target as ValueNode).value : "";
					return st.target_is_class || (tv !== "" && tv !== "self");
				})()
			) {
				// A struct instance's plain `string` field assignment. For
				// CLASSES the field is always heap (`_init` strdup's the
				// default, `<Class>_destroy` frees the final value): strdup any
				// non-heap RHS, free the displaced old value unconditionally.
				// For VALUE structs the field holds borrow semantics (rodata
				// literals / borrows are stored RAW — the checker's borrow
				// discipline already forbids mutating a source an outstanding
				// borrow points into, and a raw store can never dangle a
				// tracked record, mirroring the C backend's raw store for
				// non-tracked shapes): only a fresh-heap RHS
				// (last_result_is_heap) transfers an owned value into the
				// field, recorded in heap_string_fields for the scope-exit
				// release (and the mov-into-container release). Overwriting a
				// recorded heap value with a non-heap one frees it and drops
				// the record.
				const string_target = field_is_struct_string(target_type, field_type, status)!;
				const target_var =
					access.target.node_type === "value" ? (access.target as ValueNode).value : "";
				const tracked_key = `${target_var}.${field_name}`;
				const is_class_target = string_target.target_is_class;
				const old_was_heap = is_class_target || !!status.heap_string_fields?.has(tracked_key);
				const offset = get_field_offset(target_type.name, field_name, status);

				get_base_address(access, status, "x0");
				status.code += `str x0, [sp, #-16]!\n`;

				status.last_result_is_heap = false;
				emit_rhs_value(node.right_value, nir_rhs, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				const rhs_is_heap = status.last_result_is_heap;
				if (is_class_target && !rhs_is_heap) {
					emit_strdup(status);
				}
				mark_moved_if_struct(node.right_value, status);
				// Spill the new value (x2/x3 are caller-saved — the free call
				// may clobber them), free the old field value, then store.
				// A fat string field is a 16-byte slot — spill and store BOTH
				// halves as one 16-byte push/pop frame.
				if (field_type?.name === "string") {
					status.code += `stp x0, x1, [sp, #-16]!\n`;
					if (old_was_heap) {
						status.code += `ldr x0, [sp, #16]\n`;
						status.code += `ldr x0, [x0, #${offset}]\n`;
						emit_free(status);
					}
					status.code += `ldp x2, x3, [sp], #16\n`;
					status.code += `ldr x0, [sp], #16\n`;
					status.code += `str x2, [x0, #${offset}]\n`;
					status.code += `str x3, [x0, #${offset + 8}]\n`;
				} else {
					status.code += `str x0, [sp, #-16]!\n`;
					if (old_was_heap) {
						status.code += `ldr x0, [sp, #16]\n`;
						status.code += `ldr x0, [x0, #${offset}]\n`;
						emit_free(status);
					}
					status.code += `ldr x2, [sp], #16\n`;
					status.code += `ldr x0, [sp], #16\n`;
					status.code += `str x2, [x0, #${offset}]\n`;
				}
				// `self.field = …` inside a value-struct method writes through
				// to the caller's storage (the caller tracks ownership);
				// recording it here would double-free at this scope's exit.
				if (!is_class_target && target_var && target_var !== "self") {
					if (rhs_is_heap) {
						record_heap_string_field(status, target_var, field_name);
					} else {
						status.heap_string_fields?.delete(tracked_key);
					}
				}
			} else if (field_is_struct && !node.operator) {
				const field_struct = status.structs.find((s) => s.name === field_type!.name);
				if (field_struct?.is_class) {
					const offset = get_field_offset(target_type.name, field_name, status);
					mark_moved_if_struct(node.right_value, status);

					get_base_address(access, status, "x0");
					status.code += `str x0, [sp, #-16]!\n`;
					status.code += `ldr x0, [x0, #${offset}]\n`;
					// Run #destroy + free on the old field value, not just a raw
					// free — otherwise resources the instance owns (nested heap,
					// handles) silently leak. For nullable fields, guard with cbz
					// so a null (0) slot is skipped: free(null) is safe but
					// calling #destroy on null would dereference it.
					const field_has_destroy = !!field_struct.functions.find((f) => f.name === "#destroy");
					if (field_type?.is_nullable) {
						const label_id = (status.label_counter = (status.label_counter ?? 0) + 1);
						const skip = `.Lskip_fd_${label_id}`;
						status.code += `cbz x0, ${skip}\n`;
						if (field_has_destroy) {
							status.code += `str x0, [sp, #-16]!\n`;
							status.code += `bl ${field_type!.name}_destroy\n`;
							status.code += `ldr x0, [sp], #16\n`;
						}
						status.code += `${skip}:\n`;
					} else if (field_has_destroy) {
						status.code += `str x0, [sp, #-16]!\n`;
						status.code += `bl ${field_type!.name}_destroy\n`;
						status.code += `ldr x0, [sp], #16\n`;
					}
					emit_free(status);

					emit_rhs_value(node.right_value, nir_rhs, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `mov x2, x0\n`;
					status.code += `ldr x0, [sp], #16\n`;

					const field_size = aarch64_size(field_type?.name ?? "int");
					if (field_size === 1) {
						status.code += `strb w2, [x0, #${offset}]\n`;
					} else if (field_size === 2) {
						status.code += `strh w2, [x0, #${offset}]\n`;
					} else if (field_size === 4) {
						status.code += `str w2, [x0, #${offset}]\n`;
					} else {
						status.code += `str x2, [x0, #${offset}]\n`;
					}
				} else {
					const offset = get_field_offset(target_type.name, field_name, status);
					const struct_size = get_struct_size(field_type!.name, status);
					mark_moved_if_struct(node.right_value, status);

					const base_reg = deferred_field_base_reg(access, status);
					if (base_reg === undefined) {
						get_base_address(access, status, "x0");
						status.code += `str x0, [sp, #-16]!\n`;
					}

					get_source_address(node.right_value, status, nir_rhs);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `mov x1, x0\n`;
					if (base_reg !== undefined) {
						status.code += `mov x0, ${base_reg}\n`;
					} else {
						status.code += `ldr x0, [sp], #16\n`;
					}

					emit_struct_copy("x1", "x0", offset, struct_size, status);
				}
			} else if (rhs_is_enum_with_data && !node.operator) {
				// Enum with associated data is multi-word (tag + payload) and
				// lives on the stack like a struct; assignment to a field must
				// struct-copy the whole value (the RHS builds to a temp address
				// in x0), not just store that address. Mirrors the variable
				// assignment path above and the struct-field branch beside it.
				const offset = get_field_offset(target_type.name, field_name, status);
				const enum_size = get_enum_size(rhs_type.name, status);
				mark_moved_if_struct(node.right_value, status);

				const base_reg = deferred_field_base_reg(access, status);
				if (base_reg === undefined) {
					get_base_address(access, status, "x0");
					status.code += `str x0, [sp, #-16]!\n`;
				}

				emit_rhs_value(node.right_value, nir_rhs, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				status.code += `mov x1, x0\n`;
				if (base_reg !== undefined) {
					status.code += `mov x0, ${base_reg}\n`;
				} else {
					status.code += `ldr x0, [sp], #16\n`;
				}

				emit_struct_copy("x1", "x0", offset, enum_size, status);
			} else {
				const offset = get_field_offset(target_type.name, field_name, status);
				const field_size = aarch64_size(field_type?.name ?? "int");

				if (node.operator) {
					// Compound assignment to a scalar struct field (e.g.
					// `self.count += 1`): load the current value, build the RHS,
					// apply the operator, and store the result back. For a
					// complex RHS the base address and current value are
					// spilled to survive the build; a simple RHS (literal /
					// plain var) touches neither x1 nor x2, so the base parks
					// in x2 with no spills. With a callee-saved base register
					// the base is never pushed — the store re-reads it after
					// the RHS (deferred_field_base_reg).
					const base_reg = deferred_field_base_reg(access, status);
					get_base_address(access, status, "x0");
					if (field_size === 1) {
						status.code += `ldrb w1, [x0, #${offset}]\n`;
					} else if (field_size === 2) {
						status.code += `ldrh w1, [x0, #${offset}]\n`;
					} else if (field_size === 4) {
						status.code += `ldr w1, [x0, #${offset}]\n`;
					} else {
						status.code += `ldr x1, [x0, #${offset}]\n`;
					}
					if (rhs_preserves_x1(node, status)) {
						status.code += `mov x2, x0\n`;
						emit_rhs_value(node.right_value, nir_rhs, status);
						if (!status.code.endsWith("\n")) {
							status.code += "\n";
						}
						emit_compound_op(node.operator, status, is_float_type(field_type?.name ?? ""));
						if (field_size === 1) {
							status.code += `strb w0, [x2, #${offset}]\n`;
						} else if (field_size === 2) {
							status.code += `strh w0, [x2, #${offset}]\n`;
						} else if (field_size === 4) {
							status.code += `str w0, [x2, #${offset}]\n`;
						} else {
							status.code += `str x0, [x2, #${offset}]\n`;
						}
						build_swap(node, status, nir_swap);
						return;
					}
					if (base_reg === undefined) {
						status.code += `str x0, [sp, #-16]!\n`;
					}
					status.code += `str x1, [sp, #-16]!\n`;
					emit_rhs_value(node.right_value, nir_rhs, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `ldr x1, [sp], #16\n`;
					emit_compound_op(node.operator, status, is_float_type(field_type?.name ?? ""));
					if (base_reg !== undefined) {
						if (field_size === 1) {
							status.code += `strb w0, [${base_reg}, #${offset}]\n`;
						} else if (field_size === 2) {
							status.code += `strh w0, [${base_reg}, #${offset}]\n`;
						} else if (field_size === 4) {
							status.code += `str w0, [${base_reg}, #${offset}]\n`;
						} else {
							status.code += `str x0, [${base_reg}, #${offset}]\n`;
						}
					} else {
						status.code += `ldr x1, [sp], #16\n`;
						if (field_size === 1) {
							status.code += `strb w0, [x1, #${offset}]\n`;
						} else if (field_size === 2) {
							status.code += `strh w0, [x1, #${offset}]\n`;
						} else if (field_size === 4) {
							status.code += `str w0, [x1, #${offset}]\n`;
						} else {
							status.code += `str x0, [x1, #${offset}]\n`;
						}
					}
				} else {
					const base_reg = deferred_field_base_reg(access, status);
					if (base_reg === undefined) {
						get_base_address(access, status, "x0");
						status.code += `str x0, [sp, #-16]!\n`;
					}

					emit_rhs_value(node.right_value, nir_rhs, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					mark_moved_if_struct(node.right_value, status);
					status.code += `mov x2, x0\n`;
					if (base_reg !== undefined) {
						if (field_size === 1) {
							status.code += `strb w2, [${base_reg}, #${offset}]\n`;
						} else if (field_size === 2) {
							status.code += `strh w2, [${base_reg}, #${offset}]\n`;
						} else if (field_size === 4) {
							status.code += `str w2, [${base_reg}, #${offset}]\n`;
						} else {
							status.code += `str x2, [${base_reg}, #${offset}]\n`;
						}
					} else {
						status.code += `ldr x0, [sp], #16\n`;

						if (field_size === 1) {
							status.code += `strb w2, [x0, #${offset}]\n`;
						} else if (field_size === 2) {
							status.code += `strh w2, [x0, #${offset}]\n`;
						} else if (field_size === 4) {
							status.code += `str w2, [x0, #${offset}]\n`;
						} else {
							status.code += `str x2, [x0, #${offset}]\n`;
						}
					}
				}
			}
		} else {
			emit_rhs_value(node.right_value, nir_rhs, status);
			status.code += `\n// complex assignment\n`;
		}
	} else {
		emit_rhs_value(node.right_value, nir_rhs, status);
		status.code += `\n// complex assignment\n`;
	}

	build_swap(node, status, nir_swap);
}
