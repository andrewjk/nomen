import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import find_enum from "../build_common/find_enum.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import {
	drop_self_written_string_field_records,
	scan_self_string_field_writes,
} from "../build_common/scan_self_string_writes.ts";
import { is_float_type } from "../built_in_types.ts";
import {
	is_built_in_type,
	is_signed_int_type,
	is_signed_type,
	type_bits,
} from "../built_in_types.ts";
import { mangled_label } from "../check/utils/function_overload.ts";
import { is_int_literal } from "../int_literal.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import IndexNode from "../nodes/IndexNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import {
	forwarded_param_tree,
	staged_data_reg,
	staged_index_reg,
	unwrap_noop_int_cast,
} from "./access_staging.ts";
import { array_licm_enabled } from "./array_licm.ts";
import build_function_call_node from "./build_function_call_node.ts";
import build_inline_method, {
	begin_inline_splice,
	end_inline_splice,
	inline_splice_active,
	naked_inline_skips_self,
} from "./build_inline_method.ts";
import build_node from "./build_node.ts";
import build_nursery_spawn from "./build_nursery_spawn.ts";
import { build_operand, tree_is_call_free } from "./build_operation_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free, emit_malloc, emit_strdup } from "./utils/audit.ts";
import {
	all_scope_frames,
	find_anchor_slot,
	mark_moved_if_struct,
	trait_class_for,
} from "./utils/auto_destroy.ts";
import {
	emit_descriptor_address,
	emit_dispose_lambda_args_a64,
	materialize_func_value_a64,
} from "./utils/closure_a64.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { emit_index_address, pointer_element_size } from "./utils/ptr_access.ts";
import { is_auto_inline_method } from "./utils/scan_inline_candidates.ts";
import { NUM_REG_ARGS } from "./utils/stack_args.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	emit_var_load,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import {
	emit_pair_load_x29,
	emit_pair_store_x29,
	emit_strdup_string,
	emit_string_pair_load_at,
} from "./utils/string_pair.ts";
import { get_enum_size } from "./utils/struct_layout.ts";
import { get_enum_sret_size } from "./utils/struct_layout.ts";
import { get_field_offset, get_struct_size } from "./utils/struct_layout.ts";
import {
	emit_view_materialize_owned,
	emit_view_string_arg,
	is_view_value,
} from "./utils/view_value.ts";

/**
 * Whether `struct_node` is a monomorphized `Array<T>` (`Array_<T>`). The mono
 * name is unambiguous — the compiler derives it itself (`"Array_" + elem`)
 * for every `Array<T>` instantiation, so a name match is always an Array mono.
 */
function is_array_mono_struct(struct_node: StructNode | undefined, status: BuildStatus): boolean {
	return (
		!!struct_node &&
		!struct_node.is_generic &&
		struct_node.name.startsWith("Array_") &&
		!!status.structs.find((s) => s.name === struct_node.name)
	);
}

// Emit `string.length` leaving the length in x0 — a load of the fat
// string's len half, never strlen. If the target expression produces an
// owned heap string temporary (e.g. Json.stringify(...) or an operator/
// interpolation result), free its ptr after reading `.len`.
// A `string` struct's self keeps its len in x20 (the pair prologue).
function emit_string_length(target: BaseNode, status: BuildStatus) {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		if (name === "self" && status.current_struct?.name === "string") {
			status.last_result_is_heap = false;
			emit_asm(status, `mov x0, x20\n`);
			return;
		}
	}
	status.last_result_is_heap = false;
	build_node(target, status);
	ensure_newline(status);
	// x0/x1 = the fat value. An owned heap temp's ptr must be freed after
	// the read (the caller keeps only the length). The len half is spilled
	// across the free call — a temporary register would be clobbered (x9-x15
	// are caller-saved).
	if (status.last_result_is_heap) {
		emit_asm(status, `str x1, [sp, #-16]!\n`);
		emit_free(status);
		emit_asm(status, `ldr x0, [sp], #16\n`);
	} else {
		emit_asm(status, `mov x0, x1\n`);
	}
	status.last_result_is_heap = false;
}

/**
 * Inline fast path for `.at(i)` on a plain (non-view) `string` receiver.
 * A string local/param keeps its fat (ptr, len) pair in two stack slots —
 * the same layout `build_view_op` relies on — and the checker has already
 * proven `at`'s `index >= 0 && index < self.length` constraint at the call
 * site (an unverifiable index is a compile error outside core, matching the
 * fixed-size array `.at` fast path, which also emits an unchecked load).
 * The generic path pays a full `bl string_at` frame per character — the
 * dominant cost of byte-scanning loops (regex engine, FASTA parsing).
 * Returns true when handled.
 */
function build_string_at_inline(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
): boolean {
	if (access_func.name !== "at" || access_func.params.length !== 1) return false;
	if (node.target.node_type !== "value") return false;
	const name = (node.target as ValueNode).value;
	if (name === "self") return false; // self rides x19/x20 in string methods
	if (name.startsWith('"')) return false; // literal receivers keep the call path
	let t: Type | undefined = type_from_value_node(node.target);
	if (!t?.name) t = status.variable_types?.get(name);
	if (!t || t.name !== "string" || t.is_view || t.is_array || t.is_ref) return false;
	const base = status.stack_offsets?.get(name);
	if (base === undefined) return false;
	// index → x1, ptr → x0, zero-extended byte load (char is unsigned).
	build_operand(access_func.params[0], "x1", status);
	ensure_newline(status);
	emit_asm(status, `ldr x0, [x29, #${base}]\n`);
	emit_asm(status, `ldrb w0, [x0, x1]\n`);
	return true;
}

/**
 * `view T` builtins, operating on the (ptr, len) slice stored in two stack
 * slots ([base]=ptr, [base+8]=len):
 *   v.at(i)        →  element at ptr[i], left in x0 (or a sret temp for a
 *                     struct element, with x0 = temp address)
 *   v.to_string()  →  malloc(len+1); memcpy; null-terminate; owned copy in x0
 *                     (string views only)
 * The receiver is either a NAMED view local/param (pair in its two stack
 * slots) or an INLINE view-producing expression such as
 * `text.slice(start, end).to_string()` — the expression leaves the pair in
 * x0/x1, which is spilled to scratch slots first. Without this, the inline
 * chain falls through to struct-method dispatch and resolves to
 * `string_to_string` (an identity `mov x0, x19`), handing consumers the raw
 * slice pointer — not NUL-terminated at len — and strlen-based readers run
 * past the slice.
 * Returns true if handled (caller skips struct-method dispatch).
 */
function build_view_op(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
): boolean {
	let t = type_from_value_node(node.target);
	if (!t?.is_view && node.target.node_type === "value") {
		const vt = status.variable_types?.get((node.target as ValueNode).value);
		if (vt?.is_view) t = vt;
	}
	if (!t?.is_view && !is_view_value(node.target, status)) return false;

	// A named view local/param keeps its (ptr, len) pair in two stack slots.
	// An inline view expression is built first (pair lands in x0/x1) and
	// spilled to scratch slots so both receiver shapes share the paths below.
	let base: number | undefined;
	if (node.target.node_type === "value") {
		base = status.stack_offsets?.get((node.target as ValueNode).value);
	}
	if (base === undefined) {
		build_node(node.target, status);
		ensure_newline(status);
		const temp_base = allocate_stack_space(status, 16, 16);
		emit_asm(status, `str x0, [x29, #${temp_base}]\n`);
		emit_asm(status, `str x1, [x29, #${temp_base + 8}]\n`);
		base = temp_base;
	}
	// When only is_view_value recognized the receiver (e.g. a view param
	// whose bare reference lost its cached type), the checker has already
	// guaranteed `.to_string` implies a `view string` — default to string.
	const view_elem = t?.name || "string";

	const elem_name = view_elem === "string" ? "char" : view_elem;

	if (access_func.name === "at" && access_func.params.length === 1) {
		// index → x0, then x1=index, x0=ptr
		build_operand(access_func.params[0], "x1", status);
		ensure_newline(status);
		emit_asm(status, `ldr x0, [x29, #${base}]\n`);
		const elem_struct = status.structs.find((s) => s.name === elem_name && !s.is_simple_type);
		if (elem_struct) {
			// Struct element: addr = ptr + index*size; memcpy into a sret temp;
			// leave x0 = temp address (matches struct-returning method calls).
			const size = get_struct_size(elem_name, status);
			emit_asm(status, `mov x2, #${size}\n`);
			emit_asm(status, `madd x0, x1, x2, x0\n`); // x0 = ptr + index*size
			const temp_offset = allocate_stack_space(status, size);
			emit_asm(status, `mov x1, x0\n`); // x1 = elem addr (src)
			emit_asm(status, `add x0, x29, #${temp_offset}\n`); // x0 = temp (dst)
			emit_asm(status, `mov x2, #${size}\n`);
			emit_asm(status, `bl _memcpy\n`);
			emit_asm(status, `add x0, x29, #${temp_offset}\n`); // reload dst
			return true;
		}
		// Primitive element: scaled load based on element width. char is a
		// unicode point (non-negative) — zero-extend like the other unsigned
		// scalar loads.
		const size = aarch64_size(elem_name);
		const signed = is_signed_int_type(elem_name);
		if (size === 1) {
			emit_asm(status, signed ? `ldrsb x0, [x0, x1]\n` : `ldrb w0, [x0, x1]\n`);
		} else if (size === 2) {
			emit_asm(status, signed ? `ldrsh x0, [x0, x1, lsl #1]\n` : `ldrh w0, [x0, x1, lsl #1]\n`);
		} else if (size === 4) {
			emit_asm(status, signed ? `ldrsw x0, [x0, x1, lsl #2]\n` : `ldr w0, [x0, x1, lsl #2]\n`);
		} else {
			emit_asm(status, `ldr x0, [x0, x1, lsl #3]\n`);
		}
		return true;
	}
	if (access_func.name === "to_string" && view_elem === "string") {
		// Load ptr/len into x0/x1, then materialize an owned, len-bounded
		// copy (malloc(len+1); memcpy; null-terminate).
		emit_asm(status, `ldr x0, [x29, #${base}]\n`);
		emit_asm(status, `ldr x1, [x29, #${base + 8}]\n`);
		emit_view_materialize_owned(status);
		status.last_result_is_heap = true;
		return true;
	}
	return false;
}

/**
 * Direct-source field read (ASM_PLAN_2 tranche H + follow-up): a field read
 * off a named receiver — a single `.field` hop or a chain of inline
 * value-struct hops (`a.b.c`, offsets summed) — loaded DIRECTLY into
 * `target_reg`; the generic path spends a `mov x0, <home>` + per-hop loads
 * + caller-side `mov <target>, x0` shuffles. Handles the same receiver
 * homes as build_access_field's generic tail (param register / ref-local
 * deref / local slot address) and the same width/signedness table. Returns
 * false for every shape build_access_field special-cases upstream (enums,
 * views, strings, func-typed fields, class vars, array/nullable receivers,
 * struct-typed final fields, chains through anything but plain value
 * structs) — the caller then falls back to build_node unchanged.
 */
/**
 * Width/signedness table for a scalar field load from a resolved base
 * address. Shared by the single-hop and chain direct-load paths (and by the
 * generic tail they replace) — same instructions, different base.
 */
function emit_scalar_field_load(
	base: string,
	offset: number,
	field_type_name: string,
	target_reg: string,
	status: BuildStatus,
): void {
	const size = aarch64_size(field_type_name);
	const signed = is_signed_type(field_type_name);
	if (size === 1) {
		emit_asm(
			status,
			signed
				? `ldrsb ${target_reg}, [${base}, #${offset}]\n`
				: `ldrb ${target_reg.replace("x", "w")}, [${base}, #${offset}]\n`,
		);
	} else if (size === 2) {
		emit_asm(
			status,
			signed
				? `ldrsh ${target_reg}, [${base}, #${offset}]\n`
				: `ldrh ${target_reg.replace("x", "w")}, [${base}, #${offset}]\n`,
		);
	} else if (size === 4) {
		emit_asm(
			status,
			signed
				? `ldrsw ${target_reg}, [${base}, #${offset}]\n`
				: `ldr ${target_reg.replace("x", "w")}, [${base}, #${offset}]\n`,
		);
	} else {
		emit_asm(status, `ldr ${target_reg}, [${base}, #${offset}]\n`);
	}
}

/**
 * Resolve the receiver's home and emit the field load from it: a callee-
 * saved param register loads directly; a slot/ref receiver resolves its
 * base address INTO the target register (this load's scratch) and loads
 * from it. Returns false when the home is neither (caller-saved param reg,
 * heap array) — the caller falls back to build_node unchanged.
 */
function load_field_from_receiver_home(
	receiver_name: string,
	offset: number,
	field_type_name: string,
	target_reg: string,
	status: BuildStatus,
): boolean {
	const paramReg = get_param_reg(receiver_name, status);
	if (paramReg && /^x(?:19|2[0-8])$/.test(paramReg)) {
		// The receiver's home IS a callee-saved register: one direct load.
		emit_scalar_field_load(paramReg, offset, field_type_name, target_reg, status);
		return true;
	}
	if (paramReg || status.heap_array_vars?.has(receiver_name)) return false;
	if (is_local_ref_var(receiver_name, status)) {
		emit_deref_var_address(status, target_reg, receiver_name);
	} else {
		emit_var_address(status, target_reg, receiver_name);
	}
	emit_scalar_field_load(target_reg, offset, field_type_name, target_reg, status);
	return true;
}

/**
 * Multi-hop direct field read (`a.b.c` off a named base — ASM_PLAN_2
 * tranche H follow-up): every intermediate hop must be a plain INLINE
 * value-struct field (a class hop is a pointer dereference, a string/view
 * hop a fat pair — both change the addressing) and the final hop a scalar;
 * the read is then `base_home + Σoffset`, one instruction where the
 * generic path built each hop through x0 with a caller-side shuffle.
 * Returns false for every other shape — the caller falls back to
 * build_node unchanged.
 */
function emit_direct_field_chain(
	access_node: AccessNode,
	target_reg: string,
	status: BuildStatus,
): boolean {
	const hops: AccessFieldNode[] = [];
	let cursor: BaseNode = access_node;
	while (cursor.node_type === "access") {
		const hop = cursor as AccessNode;
		if (hop.access?.node_type !== "access_field") return false;
		hops.unshift(hop.access as AccessFieldNode);
		cursor = hop.target;
	}
	if (cursor.node_type !== "value") return false;
	const receiver_name = (cursor as ValueNode).value;
	if (typeof receiver_name !== "string" || receiver_name === "null") return false;

	let base_type = type_from_value_node(cursor);
	if (!base_type?.name) {
		if (receiver_name === "self" && status.current_struct) {
			base_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(receiver_name)) {
			base_type = status.variable_types.get(receiver_name)!;
		} else {
			const decl = status.scoped_declarations.findLast((d) => d.name === receiver_name);
			if (decl?.type?.name) {
				base_type = decl.type;
			}
		}
	}
	if (!base_type?.name) return false;
	if (base_type.is_array || base_type.is_view || base_type.is_nullable) return false;
	if (base_type.name === "string" || base_type.name === "func") return false;
	const base_struct = status.structs.find((s) => s.name === base_type.name && !s.is_generic);
	if (!base_struct || base_struct.is_class || base_struct.is_simple_type) return false;
	if (!base_struct.fields.find((f) => f.name === hops[0].name)) return false;
	if (status.bitsets.find((b) => b.name === base_type.name)) return false;
	if (receiver_name === "self" && is_array_mono_struct(base_struct, status)) return false;

	let hop_type = base_type;
	let offset = 0;
	let final_field_type = "";
	for (let i = 0; i < hops.length; i++) {
		const field = resolve_field_type(hops[i], hop_type.name, status);
		const field_name = field?.name || "";
		if (!field_name || field!.is_ref || field!.is_nullable || field!.is_view) return false;
		const field_struct = status.structs.find((s) => s.name === field_name && !s.is_simple_type);
		// The offset hop is looked up in the struct CONTAINING it (hop_type);
		// only afterwards does hop_type advance to the field's own struct.
		offset += get_field_offset(hop_type.name, hops[i].name, status);
		if (i === hops.length - 1) {
			// Final hop: scalar only. Struct-typed fields (value or class),
			// fat strings, func fields, and multi-word enum payloads stay on
			// the generic path.
			final_field_type = field_name;
			if (field_struct || field_name === "string" || field_name === "func") return false;
			if (status.enums.find((e) => e.name === field_name && e.has_associated_data)) {
				return false;
			}
		} else {
			if (!field_struct || field_struct.is_class) return false;
			hop_type = field!;
		}
	}
	return load_field_from_receiver_home(receiver_name, offset, final_field_type, target_reg, status);
}

export function emit_direct_field_load(
	node: BaseNode,
	target_reg: string,
	status: BuildStatus,
): boolean {
	if (node.node_type !== "access") return false;
	const access_node = node as AccessNode;
	if (access_node.access?.node_type !== "access_field") return false;
	// Multi-hop chain: same direct-load idea with the offsets summed.
	if (access_node.target?.node_type === "access") {
		return emit_direct_field_chain(access_node, target_reg, status);
	}
	if (access_node.target?.node_type !== "value") return false;
	const access_field = access_node.access as AccessFieldNode;
	const receiver_name = (access_node.target as ValueNode).value;
	if (typeof receiver_name !== "string" || receiver_name === "null") return false;
	if (access_field.type?.name === "func") return false;

	let target_type = type_from_value_node(access_node.target);
	if (!target_type?.name) {
		if (receiver_name === "self" && status.current_struct) {
			target_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(receiver_name)) {
			target_type = status.variable_types.get(receiver_name)!;
		} else {
			const decl = status.scoped_declarations.findLast((d) => d.name === receiver_name);
			if (decl?.type?.name) {
				target_type = decl.type;
			}
		}
	}
	if (!target_type?.name) return false;
	if (target_type.is_array || target_type.is_view || target_type.is_nullable) return false;
	if (target_type.name === "string" || target_type.name === "func") return false;
	// POSITIVE gate: the generic tail is only valid for a plain VALUE STRUCT
	// receiver whose field list actually contains the accessed name. Every
	// other shape build_access_field handles upstream (bitset cases, enums
	// and their payloads, static/type members, array length, array-mono
	// self, trait receivers) must fall back to build_node unchanged.
	const target_struct = status.structs.find((s) => s.name === target_type.name && !s.is_generic);
	if (!target_struct || target_struct.is_class || target_struct.is_simple_type) return false;
	if (!target_struct.fields.find((f) => f.name === access_field.name)) return false;
	if (status.bitsets.find((b) => b.name === target_type.name)) return false;
	if (receiver_name === "self" && is_array_mono_struct(target_struct, status)) return false;

	const field_type_obj = resolve_field_type(access_field, target_type.name, status);
	const resolved_field_type = field_type_obj?.name || "";
	const field_is_struct =
		!!resolved_field_type &&
		!field_type_obj?.is_ref &&
		!field_type_obj?.is_nullable &&
		is_struct_type(resolved_field_type, status);
	if (field_is_struct || resolved_field_type === "string" || field_type_obj?.is_view) return false;

	const offset = compute_field_offset(access_node, status);
	return load_field_from_receiver_home(
		receiver_name,
		offset,
		resolved_field_type,
		target_reg,
		status,
	);
}

export function emit_address_of(node: BaseNode, status: BuildStatus) {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x0", name);
		} else if (status.heap_array_vars?.has(name)) {
			emit_var_load(status, "x0", name, 8);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const access_field = access.access as AccessFieldNode;
			const target_type = type_from_value_node(access.target);
			const offset = get_field_offset(target_type.name, access_field.name, status);
			if (access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				const paramReg = get_param_reg(name, status);
				if (paramReg) {
					if (paramReg !== "x0") {
						emit_asm(status, `mov x0, ${paramReg}\n`);
					}
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
			} else {
				emit_address_of(access.target, status);
				ensure_newline(status);
			}
			if (offset) {
				emit_asm(status, `add x0, x0, #${offset}\n`);
			}
		} else {
			build_node(node, status);
			ensure_newline(status);
		}
	} else {
		build_node(node, status);
		ensure_newline(status);
	}
}

let access_temp_counter = 0;

function is_struct_type(type_name: string, status: BuildStatus): boolean {
	// A class is a reference type (heap pointer passed by value), not a value
	// struct passed by address — exclude it so class args/fields take the
	// scalar pointer path instead of being emitted by address + dereferenced.
	return !!status.structs.find((s) => s.name === type_name && !s.is_simple_type && !s.is_class);
}

function is_enum_with_data_type(type_name: string, status: BuildStatus): boolean {
	const e = status.enums.find((e) => e.name === type_name);
	return !!e && !!e.has_associated_data;
}

function resolve_field_type(
	access_field: AccessFieldNode,
	target_type_name: string | undefined,
	status: BuildStatus,
): Type | undefined {
	// The cached type on the access node can be a stale generic type-parameter
	// name (e.g. "T") on a monomorphised method body: node types inside the
	// body are NOT substituted during monomorphization (only param / return /
	// field-declaration types and raw #arch blocks are). Trust the cached type
	// only when it names a concrete type; otherwise consult the struct's field
	// declaration, which carries the substituted concrete type (e.g. Pt).
	const cached = access_field.type?.name;
	if (cached && is_concrete_type_name(cached, status)) return access_field.type;
	if (!target_type_name) return access_field.type;
	const target_struct = status.structs.find(
		(s) => s.name === target_type_name && !s.is_simple_type,
	);
	const field = target_struct?.fields.find((f) => f.name === access_field.name);
	return field?.type ?? access_field.type;
}

function is_concrete_type_name(name: string, status: BuildStatus): boolean {
	return (
		is_built_in_type(name) ||
		!!status.structs.find((s) => s.name === name) ||
		!!status.enums.find((e) => e.name === name) ||
		!!status.traits.find((t) => t.name === name)
	);
}

export function reset_access_temp_counter() {
	access_temp_counter = 0;
}

let func_field_temp_counter = 0;

/**
 * A call through a func-typed struct FIELD (`s.f(args)`): load the field's
 * stored code pointer, park it in a stack slot, then delegate to the ordinary
 * func-VALUE call lowering (which loads the pointer into x8, evaluates the
 * args into the AAPCS registers, and `blr`s). The func-value path already
 * handles the arg forms a signature can carry (fat string pairs, etc.), so a
 * field call behaves exactly like calling a func-typed local.
 */
function build_func_field_call(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
): void {
	const target_type = type_from_value_node(node.target);
	const struct = status.structs.find((s) => s.name === target_type.name);
	const field = struct?.fields.find((f) => f.name === access_func.name);
	if (!field || !field.func_params) {
		// The checker only marks real func fields; fall back to a plain read.
		build_node(node.target, status);
		return;
	}
	// Load the field through the ordinary field-access path (handles `.`/`->`
	// and ref receivers uniformly).
	const field_access = new AccessNode(
		node.start,
		node.target,
		new AccessFieldNode(node.start, access_func.name, field.type),
	);
	build_node(field_access, status);
	ensure_newline(status);
	// Park the code pointer where the func-value call path expects to load it.
	const temp = `_funcfield_${func_field_temp_counter++}`;
	const off = allocate_stack_space(status, 8);
	if (!status.stack_offsets) status.stack_offsets = new Map();
	status.stack_offsets.set(temp, off);
	emit_asm(status, `str x0, [x29, #${off}]\n`);
	// Delegate: a synthetic func-value call named for the parked slot.
	const call = new FunctionCallNode(node.start, temp);
	call.is_func_param = true;
	call.params = access_func.params;
	call.type = access_func.type;
	build_function_call_node(call, status);
}

export default function build_access_node(node: AccessNode, status: BuildStatus) {
	// Consume-once marker for the fixed-array pipeline: a stale value from an
	// earlier `.at()` must never leak into an unrelated field hop.
	status.at_addr_reg = undefined;
	switch (node.access.node_type) {
		case "access_field": {
			build_access_field(node, status);
			break;
		}
		case "access_func": {
			const access_func = node.access as AccessFunctionCallNode;
			// Thread.start / Thread.detach / Fiber.start are ordinary
			// methods on the library classes (ASYNC.md);
			// start_on's checker rewrites it to start after validating the
			// stack buffer.
			// Escape hatch: `nursery.start(Thread(fn(args)))`. See ASYNC.md.
			if (access_func.is_nursery_spawn) {
				build_nursery_spawn(node, access_func, status);
				return;
			}
			// `view T` builtins (.at, .to_string) operate on the (ptr, len)
			// slice directly — emit inline and skip struct-method dispatch.
			if (build_view_op(node, access_func, status)) {
				return;
			}
			// Plain `string .at(i)` — same fat-pair layout, inline ldrb.
			if (build_string_at_inline(node, access_func, status)) {
				return;
			}
			// `s.f(args)` where `f` is a func-typed FIELD: an indirect call
			// through the stored code pointer (`ldr x8, …; blr x8`).
			if (access_func.is_func_field_call) {
				build_func_field_call(node, access_func, status);
				return;
			}
			build_access_method(node, access_func, status);
			break;
		}
	}
}

function compute_field_offset(node: AccessNode, status: BuildStatus): number {
	if (node.access.node_type === "access_field") {
		let target_type = type_from_value_node(node.target);
		if (!target_type?.name && node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			if (name === "self" && status.current_struct) {
				target_type = new Type(status.current_struct.name);
			} else if (status.variable_types?.has(name)) {
				target_type = status.variable_types.get(name)!;
			} else {
				// Local variables: look up the declaration's type so that
				// nested field access on locals resolves the correct offset.
				const decl = status.scoped_declarations.findLast((d) => d.name === name);
				if (decl?.type?.name) {
					target_type = decl.type;
				}
			}
		}
		// Resolve access targets whose type_from_value_node returned empty.
		// This happens for nested struct field access like `self.keys.cap`
		// where the access_field's .type wasn't populated during checking —
		// resolve_access_type walks the chain via status.structs instead.
		if (!target_type?.name && node.target.node_type === "access") {
			const resolved = resolve_access_type(node.target as AccessNode, status);
			if (resolved) target_type = resolved;
		}
		const field_name = (node.access as AccessFieldNode).name;
		let offset = get_field_offset(target_type?.name || "", field_name, status);

		if (node.target.node_type === "access") {
			const inner_access = node.target as AccessNode;
			offset += compute_field_offset(inner_access, status);
		}

		return offset;
	}

	return 0;
}

function get_base_target(node: AccessNode): ValueNode | AccessNode {
	if (node.target.node_type === "access") {
		return get_base_target(node.target as AccessNode);
	}
	return node.target as ValueNode;
}

/**
 * Resolve the concrete type of an access target (a local/param/`self` value or
 * a nested access), consulting the containing struct's field declarations when
 * a cached type is absent — an inferred `move` class field
 * (`pub move rules = RuleSet()`) carries no cached AccessFieldNode.type.
 */
function resolve_access_target_type(target: BaseNode, status: BuildStatus): Type | undefined {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		if (name === "self" && status.current_struct) return new Type(status.current_struct.name);
		if (status.variable_types?.has(name)) return status.variable_types.get(name);
		const decl = status.scoped_declarations.findLast((d) => d.name === name);
		if (decl?.type?.name) return decl.type;
		return type_from_value_node(target);
	}
	if (target.node_type === "access") {
		return (
			type_from_value_node(target) ?? resolve_access_type(target as AccessNode, status) ?? undefined
		);
	}
	return type_from_value_node(target);
}

/**
 * Whether reading the final field of `node` must dereference an intermediate
 * pointer. The summed-offset-from-root load (`compute_field_offset` + the
 * base address) is only valid while every hop is an INLINE value struct. A
 * class-typed field — or a class-typed root value — stores a POINTER, so the
 * chain has to be built recursively (each pointer hop loaded) before the
 * final field is read. Without this, `state.rules.blocks.length` (State/
 * BlockParserState is a class) summed 8+8+8 and loaded from `state + 24`.
 */
function access_chain_crosses_class(node: AccessNode, status: BuildStatus): boolean {
	const base = get_base_target(node);
	const base_type = resolve_access_target_type(base, status);
	if (base_type?.name && status.structs.find((s) => s.name === base_type.name && s.is_class)) {
		return true;
	}
	let cursor: BaseNode = node;
	while (cursor.node_type === "access") {
		const acc = cursor as AccessNode;
		if (acc.access.node_type !== "access_field") return false;
		const ft = resolve_field_type(
			acc.access as AccessFieldNode,
			resolve_access_target_type(acc.target, status)?.name,
			status,
		);
		if (ft?.name && status.structs.find((s) => s.name === ft.name && s.is_class)) return true;
		cursor = acc.target;
	}
	return false;
}

function get_param_reg(name: string, status: BuildStatus): string | undefined {
	return status.function_param_regs?.get(name);
}

// Callee-saved register pool used to cache loop-invariant Buffer.data
// pointers across loop iterations.
const BUFFER_DATA_CACHE_REGS = ["x23", "x24", "x25", "x26", "x27", "x28"];

// Compute a syntactic cache key for a Buffer access target so that repeated
// accesses to the same Buffer (local variable `b` or struct field `o.f`)
// reuse one cached data pointer. Returns null for targets we can't key
// (nested accesses, computed bases, …) — those are never cached/hoisted.
export function buffer_cache_key(target: BaseNode): string | null {
	if (target.node_type === "value") {
		return (target as ValueNode).value;
	}
	if (target.node_type === "access" && (target as AccessNode).access.node_type === "access_field") {
		const inner = target as AccessNode;
		const inner_field = inner.access as AccessFieldNode;
		if (inner.target.node_type === "value") {
			return `${(inner.target as ValueNode).value}.${inner_field.name}`;
		}
	}
	return null;
}

// Emit the address of a Buffer VALUE (the Buffer struct itself, not its
// .data pointer) into x9. Handles local variables, params, `self`, and
// `obj.field` targets. This is the former `emit_buf_addr_to_x9` closure,
// lifted to module scope so the loop-invariant hoist (loop_buffer_licm) can
// call it from the loop preheader — and so the NEON vectorizer's preheader
// can pin data pointers the same way.
export function emit_buffer_struct_addr(target: BaseNode, status: BuildStatus) {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			emit_asm(status, `mov x9, ${paramReg}\n`);
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x9", name);
		} else {
			emit_var_address(status, "x9", name);
		}
	} else if (
		target.node_type === "access" &&
		(target as AccessNode).access.node_type === "access_field"
	) {
		const inner = target as AccessNode;
		const inner_field = inner.access as AccessFieldNode;
		// Resolve the base type, handling `self` and locals — type_from_value_node
		// returns undefined for `self` (not a declared variable), which would make
		// get_field_offset look up an empty struct name and fall back to the
		// default VT_SIZE (8) for every field.
		let inner_base_type: Type | undefined = type_from_value_node(inner.target);
		if (!inner_base_type?.name && inner.target.node_type === "value") {
			const bname = (inner.target as ValueNode).value;
			if (bname === "self" && status.current_struct) {
				inner_base_type = new Type(status.current_struct.name);
			} else if (status.variable_types?.has(bname)) {
				inner_base_type = status.variable_types.get(bname);
			} else {
				const decl = status.scoped_declarations.findLast((d) => d.name === bname);
				if (decl?.type?.name) inner_base_type = decl.type;
			}
		}
		const foff = get_field_offset(inner_base_type?.name || "", inner_field.name, status);
		if (inner.target.node_type === "value") {
			const bname = (inner.target as ValueNode).value;
			const bpReg = get_param_reg(bname, status);
			if (bpReg) {
				emit_asm(status, `mov x9, ${bpReg}\n`);
			} else if (is_local_ref_var(bname, status)) {
				emit_deref_var_address(status, "x9", bname);
			} else {
				emit_var_address(status, "x9", bname);
			}
		} else {
			build_node(inner.target, status);
			ensure_newline(status);
			emit_asm(status, `mov x9, x0\n`);
		}
		if (foff > 0) {
			emit_asm(status, `add x9, x9, #${foff}\n`);
		}
	} else {
		build_node(target, status);
		ensure_newline(status);
		emit_asm(status, `mov x9, x0\n`);
	}
}

// Allocate a callee-saved register to cache a Buffer data pointer, for the
// inlined Buffer load/store fast path's within-body dedup. Draws from the
// x23-x28 pool, excluding registers bound to a promoted variable
// (register_allocations), already holding a cached pointer
// (buffer_data_cache), OR claimed earlier in the function
// (callee_saved_regs_used).
//
// That last exclusion is the subtle one: the cache Map is logical state that
// gets snapshotted/restored across if/switch/match/loop bodies, but the
// registers it references are physical state shared across the whole
// function. A register claimed in an OUTER scope (and still referenced by
// the outer's cache Map) MUST NOT be reassigned in a sub-scope — otherwise
// on restore, the outer Map points at a register whose contents were
// overwritten by the sub-scope. Once a register has been claimed anywhere
// in the function it stays claimed for the function's duration, which is
// what `callee_saved_regs_used` already tracks (it's the same set used to
// decide which regs to save in the prologue). Loop variable promotion
// (build_for_loop_node / build_while_loop_node) uses the same set the same
// way, so this also prevents buffer-cache allocation from clobbering a
// loop's promoted variables.
export function alloc_buffer_cache_reg(status: BuildStatus): string | null {
	const used = new Set(status.register_allocations?.values() ?? []);
	const cached_regs = new Set(status.buffer_data_cache?.values() ?? []);
	const claimed = new Set(status.callee_saved_regs_used ?? []);
	for (const r of BUFFER_DATA_CACHE_REGS) {
		if (used.has(r) || cached_regs.has(r) || claimed.has(r)) continue;
		if (status.buffer_data_cache) {
			for (const [k, v] of status.buffer_data_cache) {
				if (v === r) status.buffer_data_cache.delete(k);
			}
		}
		return r;
	}
	return null;
}

// Return the register holding a Buffer's data pointer for `target`, emitting
// a load (and caching it) on a miss. Used by the inlined Buffer load/store
// fast path. On a cache hit, emits nothing and returns the cached register.
function get_buffer_data_ptr(target: BaseNode, status: BuildStatus): string {
	const key = buffer_cache_key(target);
	if (key && status.buffer_data_cache?.has(key)) {
		return status.buffer_data_cache.get(key)!;
	}
	emit_buffer_struct_addr(target, status);
	emit_asm(status, `ldr x9, [x9, #8]\n`);
	if (key && status.function_return_label) {
		const cache_reg = alloc_buffer_cache_reg(status);
		if (cache_reg) {
			emit_asm(status, `mov ${cache_reg}, x9\n`);
			if (!status.buffer_data_cache) status.buffer_data_cache = new Map();
			status.buffer_data_cache.set(key, cache_reg);
			if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
			status.callee_saved_regs_used.add(cache_reg);
			return cache_reg;
		}
	}
	return "x9";
}

/**
 * Base-folded addressing (ASM_PLAN_6 tranche 3): when the index argument is
 * `base + var` (both plain names, after param forwarding / VN splicing) and
 * the region bracket preloaded a fold register for this (receiver, base)
 * pair, return the fold register plus the var's live register. Every gate
 * is re-checked here against the LIVE maps — a plan-recorded fold whose
 * base storage turned out untrustworthy (a forward-elided `_vn` declare
 * writes no slot, a `_param_` temp, an index-constant unroll copy, a
 * slot-resident induction) simply never matches, and the access falls back
 * to the ordinary staged path.
 */
function lookup_buffer_fold(
	target: BaseNode,
	index_param: BaseNode,
	status: BuildStatus,
): { reg: string; var_reg: string } | null {
	const folds = status.buffer_fold_cache;
	if (!folds || folds.size === 0) return null;
	const key = buffer_cache_key(target);
	if (!key) return null;
	const effective = forwarded_param_tree(index_param, status) ?? index_param;
	if (effective.node_type !== "op") return null;
	const op = effective as OperationNode;
	if (op.op !== "+" || !op.left_value || !op.right_value) return null;
	const leaf_name = (n: BaseNode | undefined): string | null => {
		if (!n || n.node_type !== "value") return null;
		const v = (n as ValueNode).value;
		if (typeof v !== "string") return null;
		// Identifier names and non-negative integer literals (constant
		// base folds) both participate; the key space cannot collide.
		return /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) || /^\d+$/.test(v) ? v : null;
	};
	const ln = leaf_name(op.left_value);
	const rn = leaf_name(op.right_value);
	if (!ln || !rn || ln === rn) return null;
	for (const [base, ind] of [
		[ln, rn],
		[rn, ln],
	]) {
		const reg = folds.get(`${key}|${base}`);
		if (!reg) continue;
		if (status.induction_const?.has(ind)) return null;
		if (status.function_param_regs?.has(ind)) return null;
		const var_reg = status.register_allocations?.get(ind);
		if (!var_reg || !var_reg.startsWith("x")) return null;
		// The base needs real storage written before the bracket opened —
		// unless it is a literal (constant offset, no storage at all).
		if (/^\d+$/.test(base)) return { reg, var_reg };
		if (base.startsWith("_param_")) return null;
		if (base.startsWith("_vn_")) {
			const def = status.nir_emit_ctx?.vn_temp_defs?.get(base);
			if (!def || status.nir_emit_ctx?.forward_defs?.has(def)) return null;
		} else if (
			!status.register_allocations?.has(base) &&
			!status.stack_offsets?.has(base) &&
			!status.function_param_regs?.has(base)
		) {
			return null;
		}
		return { reg, var_reg };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Fixed-array element-address pipeline (ASM_PLAN_3 tranche A).
//
// `arr.at(i)` on a FIXED-SIZE array of structs leaves the element ADDRESS in
// x0 — but today every access re-derives that address (base slot load +
// stride constant + index shift + add). For a repeated (array, index) pair
// within one region the address is invariant, so it is computed once into a
// pinned callee-saved register and every further access is a single
// `ldr [p, #off]`. Soundness: a fixed array IS storage — a local slot or a
// ref-param pointer to caller storage — so the element base `base + i*stride`
// cannot change while neither the array nor the index is reassigned. The
// cache is invalidated on assignments to either name, on any non-inlined
// call (a ref arg may write the index), and at loop/branch/function/inline
// boundaries (the same bracketing as buffer_data_cache). Dynamic (heap)
// arrays are excluded wholesale: their base pointer moves on realloc.
// ---------------------------------------------------------------------------

/**
 * Cache key for a fixed-array `.at(index)` access: `"<array>@<index>"` where
 * <array> is the buffer-style key (name or "obj.field") and <index> is a
 * plain identifier. Returns null for every shape the pipeline must not
 * cache: non-identifier indexes (literals, expressions), dynamic arrays,
 * non-struct or class elements, non-inlineable targets.
 */
export function fixed_array_cache_key(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
): string | null {
	if (!array_licm_enabled()) return null;
	if (access_func.name !== "at" || access_func.params.length !== 1) return null;
	const idx = access_func.params[0];
	if (idx.node_type !== "value") return null;
	const idx_name = (idx as ValueNode).value;
	if (typeof idx_name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(idx_name)) return null;

	const target_type = type_from_value_node(node.target);
	if (!target_type?.is_array) return null;
	// Fixed-size only: a real source position on the length. Dynamic arrays
	// (length.start = -1) live on the heap and move on realloc/grow.
	if (!target_type.length || (target_type.length.start ?? -1) < 0) return null;
	// The element must be a non-class struct — the cached register holds the
	// element ADDRESS (the .at() contract for struct elements).
	const elem_struct = status.structs.find((s) => s.name === target_type.name && !s.is_simple_type);
	if (!elem_struct || elem_struct.is_class) return null;

	const is_struct_field_target =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_field";
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		// Heap dynamic arrays are excluded above via the length check; this
		// also guards any value target whose storage rides the heap path.
		if (status.heap_array_vars?.has(name)) return null;
	} else if (!is_struct_field_target) {
		return null;
	}
	const arr_key = buffer_cache_key(node.target);
	if (!arr_key) return null;
	return `${arr_key}@${idx_name}`;
}

/** First free register for the fixed-array cache, or null. Same pool and
 * exclusions as alloc_buffer_cache_reg (promotions, both caches, anything
 * claimed earlier in the function). Pure — claims happen at the call site. */
function alloc_array_cache_reg(status: BuildStatus): string | null {
	const used = new Set(status.register_allocations?.values() ?? []);
	const cached = new Set(status.buffer_data_cache?.values() ?? []);
	const mine = new Set(status.array_ptr_cache?.values() ?? []);
	const claimed = new Set(status.callee_saved_regs_used ?? []);
	for (const r of BUFFER_DATA_CACHE_REGS) {
		if (used.has(r) || cached.has(r) || mine.has(r) || claimed.has(r)) continue;
		return r;
	}
	return null;
}

/**
 * Store-side resolution for `arr.at(i).field = rhs`: returns the pinned
 * register holding the element address (consulting or filling the cache),
 * or undefined to keep the historical get_base_address + push flow. The
 * register is callee-saved and claimed for the function, so it survives the
 * RHS build — the same contract as deferred_field_base_reg.
 */
export function resolve_at_element_addr(target: BaseNode, status: BuildStatus): string | undefined {
	if (!array_licm_enabled()) return undefined;
	if (target.node_type !== "access") return undefined;
	const acc = target as AccessNode;
	if (acc.access.node_type !== "access_func") return undefined;
	const af = acc.access as AccessFunctionCallNode;
	const key = fixed_array_cache_key(acc, af, status);
	if (!key) return undefined;
	const cached = status.array_ptr_cache?.get(key);
	if (cached) return cached;
	if (alloc_array_cache_reg(status) === null) return undefined;
	status.at_addr_reg = undefined;
	build_node(acc, status);
	const reg = status.at_addr_reg;
	status.at_addr_reg = undefined;
	return reg ?? undefined;
}

function build_access_field(node: AccessNode, status: BuildStatus) {
	// `unsafe` member load through a pointer-indexed element (`p[i].field`):
	// compute the element address (x9), add the member offset, and load with
	// the member's width (a string member loads the (ptr, len) pair).
	if (node.target.node_type === "index") {
		const index = node.target as IndexNode;
		const access_field_early = node.access as AccessFieldNode;
		const elem = index.type ?? new Type(type_from_value_node(index.target).name);
		build_node(index.target, status);
		ensure_newline(status);
		emit_asm(status, `str x0, [sp, #-16]!\n`);
		build_node(index.index, status);
		ensure_newline(status);
		emit_asm(status, `mov x1, x0\n`);
		emit_asm(status, `ldr x0, [sp], #16\n`);
		emit_index_address(pointer_element_size(elem, status), status);
		let offset: number;
		if (elem.name === "string") {
			offset = access_field_early.name === "len" ? 8 : 0;
		} else {
			offset = get_field_offset(elem.name, access_field_early.name, status);
		}
		if (offset > 0) emit_asm(status, `add x9, x9, #${offset}\n`);
		const field_type = access_field_early.type;
		if (field_type?.name === "string") {
			emit_asm(status, `ldp x0, x1, [x9]\n`);
			return;
		}
		const fsize = aarch64_size(field_type?.name || elem.name);
		if (fsize === 1) emit_asm(status, `ldrb w0, [x9]\n`);
		else if (fsize === 2) emit_asm(status, `ldrh w0, [x9]\n`);
		else if (fsize === 4) emit_asm(status, `ldr w0, [x9]\n`);
		else emit_asm(status, `ldr x0, [x9]\n`);
		return;
	}
	let target_type = type_from_value_node(node.target);
	if (!target_type?.name && node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		if (name === "self" && status.current_struct) {
			target_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(name)) {
			target_type = status.variable_types.get(name)!;
		} else {
			// Local variables: look up the declaration's type.
			// Without this, nested field access on locals (e.g. `old_keys.cap`)
			// falls back to VT_SIZE for the offset, reading the wrong field.
			const decl = status.scoped_declarations.findLast((d) => d.name === name);
			if (decl?.type?.name) {
				target_type = decl.type;
			}
		}
	}
	const target_name =
		node.target.node_type === "value" ? (node.target as ValueNode).value : target_type?.name;
	const access_field = node.access as AccessFieldNode;

	// Inside a compiled `Array<T>` method body, `self` follows the aarch64
	// array receiver convention every call site already passes (see the
	// receiver loading in build_access_method): the FIRST ELEMENT pointer,
	// with the length prefix at [self - 8] — not the VT-prefixed struct
	// layout the generic field path below assumes ([self + 8]). The raw
	// `#arch` Array bodies read the same [-8] prefix (at_end/add/mul), so a
	// Nomen-level body must agree with them. Only `self` can carry the mono
	// struct type here — every other array-typed value stays element-typed
	// (`T[]`/`Array<T>`) and dispatches through the is_array paths above.
	if (
		access_field.name === "length" &&
		node.target.node_type === "value" &&
		(node.target as ValueNode).value === "self" &&
		is_array_mono_struct(status.current_struct, status)
	) {
		const self_reg = get_param_reg("self", status);
		if (self_reg) {
			if (self_reg !== "x0") {
				emit_asm(status, `mov x0, ${self_reg}\n`);
			}
			emit_asm(status, `ldr x0, [x0, #-8]\n`);
			return;
		}
	}

	// A func-typed access is a STATIC METHOD REFERENCE (`Console.write` used
	// as a value → the function label) unless the struct actually stores a
	// func-typed FIELD of that name, in which case it is a stored code
	// pointer that falls through to the ordinary 8-byte field load below.
	const func_field_owner = status.structs.find((s) => s.name === target_type?.name);
	const is_stored_func_field = !!func_field_owner?.fields.find(
		(f) => f.name === access_field.name && f.func_params,
	);
	if (access_field.type?.name === "func" && !is_stored_func_field) {
		// A static method reference as a VALUE materializes its closure
		// descriptor (CLOSURE.md) under the Struct_method label
		// convention.
		const method = func_field_owner?.functions.find((f) => f.name === access_field.name);
		if (method) {
			const conventional = `${target_type.name}_${access_field.name}`;
			if (!method.label_name) method.label_name = conventional;
			const desc = materialize_func_value_a64(method, status);
			emit_descriptor_address(status, "x0", desc);
			return;
		}
		emit_asm(status, `adr x0, ${target_type.name}_${access_field.name}\n`);
		return;
	}

	const enum_node = find_enum(target_type?.name, status) ?? find_enum(target_name, status);
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === access_field.name);
		if (enum_case) {
			const case_index = enum_node.cases.indexOf(enum_case);
			if (enum_node.has_associated_data && enum_case.params.length === 0) {
				const enum_size = get_enum_size(target_name || target_type?.name || "", status);
				const temp_name = `_enum_${access_temp_counter++}`;
				const temp_offset = allocate_stack_space(status, enum_size);
				status.stack_offsets!.set(temp_name, temp_offset);
				emit_asm(status, `add x0, x29, #${temp_offset}\n`);
				emit_asm(status, `mov x1, #${case_index}\n`);
				emit_asm(status, `str x1, [x0]\n`);
				for (let off = 8; off < enum_size; off += 8) {
					emit_asm(status, `str xzr, [x0, #${off}]\n`);
				}
			} else {
				emit_asm(status, `mov x0, #${case_index}\n`);
			}
			return;
		}
	}

	// Check for enum payload field access (e.g., insect.count)
	const enum_candidate = find_enum(target_type?.name, status) ?? find_enum(target_name, status);
	const enum_with_data = enum_candidate?.has_associated_data ? enum_candidate : undefined;
	if (enum_with_data) {
		for (const c of enum_with_data.cases) {
			const param = c.params.find((p) => p.name === access_field.name);
			if (param) {
				let payload_offset = 8;
				for (const p of c.params) {
					if (p.name === access_field.name) break;
					payload_offset += aarch64_size(p.type.name);
				}
				if (node.target.node_type === "value") {
					const name = (node.target as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						if (paramReg !== "x0") {
							emit_asm(status, `mov x0, ${paramReg}\n`);
						}
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x0", name);
					} else if (status.heap_array_vars?.has(name)) {
						emit_var_load(status, "x0", name, 8);
						emit_asm(status, `add x0, x0, #8\n`);
					} else {
						emit_var_address(status, "x0", name);
					}
				} else {
					build_node(node.target, status);
					ensure_newline(status);
				}
				const field_type = access_field.type?.name || "int";
				const field_size = aarch64_size(field_type);
				const signed = is_signed_type(field_type);
				if (field_size === 1) {
					emit_asm(
						status,
						signed ? `ldrsb x0, [x0, #${payload_offset}]\n` : `ldrb w0, [x0, #${payload_offset}]\n`,
					);
				} else if (field_size === 4) {
					emit_asm(
						status,
						signed ? `ldrsw x0, [x0, #${payload_offset}]\n` : `ldr w0, [x0, #${payload_offset}]\n`,
					);
				} else {
					emit_asm(status, `ldr x0, [x0, #${payload_offset}]\n`);
				}
				return;
			}
		}
	}

	const bitset_node = status.bitsets.find((b) => b.name === target_type.name);
	if (bitset_node) {
		const case_index = bitset_node.cases.indexOf(access_field.name);
		if (case_index >= 0) {
			// Emit the evaluated single-bit constant, not the `#(1 << N)`
			// expression text — the asm validator (and GAS) only accept
			// plain immediates here.
			emit_asm(status, `mov x0, #${2 ** case_index}\n`);
			return;
		}
	}

	if (target_type.is_array && access_field.name === "length") {
		// Variadic param .length → load from stack offset of hidden _name_len
		if (
			node.target.node_type === "value" &&
			status.function_variadic_params?.has((node.target as ValueNode).value)
		) {
			const name = (node.target as ValueNode).value;
			const offset = status.stack_offsets?.get(`_${name}_len`);
			if (offset !== undefined) {
				emit_asm(status, `ldr x0, [x29, #${offset}]\n`);
			} else {
				emit_asm(status, `mov x0, #0\n`);
			}
			return;
		}
		// For heap arrays: load pointer, then load length from [pointer]
		if (
			node.target.node_type === "value" &&
			status.heap_array_vars?.has((node.target as ValueNode).value)
		) {
			const name = (node.target as ValueNode).value;
			emit_var_load(status, "x0", name, 8);
			ensure_newline(status);
			emit_asm(status, `ldr x0, [x0]\n`);
			return;
		}
		// For stack arrays: load length from the 8-byte prefix at [base - 8]
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const offset = status.stack_offsets?.get(name);
			if (offset !== undefined) {
				// Array parameters store a pointer — dereference to get length from [ptr - 8]
				if (status.function_array_params?.has(name)) {
					emit_asm(status, `ldr x0, [x29, #${offset}]\n`);
					emit_asm(status, `ldr x0, [x0, #-8]\n`);
				} else {
					emit_asm(status, `ldr x0, [x29, #${offset - 8}]\n`);
				}
				return;
			}
			// Global array: length prefix is at label - 8
			emit_asm(status, `adr x0, ${name}\n`);
			emit_asm(status, `ldr x0, [x0, #-8]\n`);
			return;
		}
		// Heap `Array<T>` FIELD (`obj.items.length`): the field holds a pointer
		// to the heap buffer with the length at [0]. Load the field value, then
		// its length word.
		if (node.target.node_type === "access" && target_type.storage_kind === "heap_array") {
			const access_target = node.target as AccessNode;
			if (access_target.access.node_type === "access_field") {
				const offset = compute_field_offset(access_target, status);
				const base = get_base_target(access_target);
				if (base.node_type === "value") {
					const name = (base as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						if (paramReg !== "x0") emit_asm(status, `mov x0, ${paramReg}\n`);
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x0", name);
					} else {
						emit_var_address(status, "x0", name);
					}
				} else {
					build_node(base, status);
					ensure_newline(status);
				}
				if (offset > 0) {
					emit_asm(status, `add x0, x0, #${offset}\n`);
				}
				emit_asm(status, `ldr x0, [x0]\n`);
				emit_asm(status, `ldr x0, [x0]\n`);
				return;
			}
		}
		emit_asm(status, `mov x0, #0\n`);
		return;
	}

	// view T.length → the slice's stored length (second word of the local).
	// Must precede the string.length case: a view string also has name "string".
	// A NAMED view local/param keeps its pair in its own two stack slots; a
	// FIELD read (`self.text.length`) builds the pair into x0/x1 through the
	// normal field-read path and takes the len half from x1.
	if (target_type.is_view && access_field.name === "length") {
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const offset = status.stack_offsets?.get(name);
			if (offset !== undefined) {
				emit_asm(status, `ldr x0, [x29, #${offset + 8}]\n`);
			} else {
				emit_asm(status, `mov x0, #0\n`);
			}
			return;
		}
		build_node(node.target, status);
		ensure_newline(status);
		emit_asm(status, `mov x0, x1\n`);
		return;
	}

	// String.length → strlen(self)
	if (!target_type.is_view && target_type.name === "string" && access_field.name === "length") {
		emit_string_length(node.target, status);
		return;
	}

	let offset = compute_field_offset(node, status);
	const base = get_base_target(node);

	const target_access_field =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_field"
			? ((node.target as AccessNode).access as AccessFieldNode)
			: undefined;
	// Resolve the intermediate field's type through the containing struct's
	// field declarations, not just the cached AccessFieldNode.type — an
	// inferred `move` class field (`pub move rules = RuleSet()`) has no cached
	// type, so the cached-only check missed the pointer hop entirely.
	const target_class_field_type = target_access_field
		? resolve_field_type(
				target_access_field,
				resolve_access_target_type((node.target as AccessNode).target, status)?.name,
				status,
			)
		: undefined;
	const target_is_class_access =
		!!target_class_field_type?.name &&
		!!status.structs.find((s) => s.name === target_class_field_type.name && s.is_class);

	// When target is a method call (e.g., points.at(0).x), build the method call
	// which leaves the result in x0, then apply the field offset from x0
	const target_is_method_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_func";

	if (target_is_method_access) {
		build_node(node.target, status);
		ensure_newline(status);
		const final_offset = offset;
		const field_type = access_field.type?.name || "";
		// Fixed-array pipeline (ASM_PLAN_3 tranche A): when the `.at()` just
		// built resolved through the pointer cache, load the field straight
		// from the pinned register instead of the x0 round trip.
		const at_reg = status.at_addr_reg;
		status.at_addr_reg = undefined;
		const load_base = at_reg ?? "x0";
		if (field_type === "string" || access_field.type?.is_view) {
			emit_string_pair_load_at(status, load_base, final_offset);
			return;
		}
		const size = aarch64_size(field_type);
		const signed = is_signed_type(field_type);
		if (at_reg !== undefined && size === 8 && is_float_type(field_type)) {
			// Float field straight into d0 — mirrors the Buffer load_float
			// fast path's d0 protocol: consume the caller's request flag;
			// without one, x0 must still receive the value (call args read
			// float bits from x0).
			const caller_wants_d0 = status.float_result_in_d0 ?? false;
			status.float_result_in_d0 = false;
			emit_asm(status, `ldr d0, [${load_base}, #${final_offset}]\n`);
			if (!caller_wants_d0) {
				emit_asm(status, `fmov x0, d0\n`);
			}
			return;
		}
		if (size === 1) {
			emit_asm(
				status,
				signed
					? `ldrsb x0, [${load_base}, #${final_offset}]\n`
					: `ldrb w0, [${load_base}, #${final_offset}]\n`,
			);
		} else if (size === 4) {
			emit_asm(
				status,
				signed
					? `ldrsw x0, [${load_base}, #${final_offset}]\n`
					: `ldr w0, [${load_base}, #${final_offset}]\n`,
			);
		} else {
			emit_asm(status, `ldr x0, [${load_base}, #${final_offset}]\n`);
		}
		return;
	}

	if (target_is_class_access) {
		build_node(node.target, status);
		ensure_newline(status);
		const final_offset = get_field_offset(target_type?.name || "", access_field.name, status);
		// A STRUCT-typed field of a class instance is embedded inline; its
		// "value" is its address (instance + offset). Prefer the struct's FIELD
		// DECLARATION type and monomorphize it (`List<BlockRule>` →
		// `List_BlockRule`): the cached AccessFieldNode.type can be the bare
		// generic, and a missed struct check would emit a scalar load that
		// dereferences the value's `_vt` as a pointer.
		const containing_struct = status.structs.find(
			(s) => s.name === (target_type?.name || "") && !s.is_simple_type,
		);
		const field_decl_type = containing_struct?.fields.find(
			(f) => f.name === access_field.name,
		)?.type;
		const class_access_field_type =
			field_decl_type ?? resolve_field_type(access_field, target_type?.name, status);
		const field_type = class_access_field_type?.type_args?.length
			? mono_type_name(class_access_field_type)
			: class_access_field_type?.name || access_field.type?.name || "";
		const class_access_is_struct =
			!!field_type &&
			!class_access_field_type?.is_ref &&
			!class_access_field_type?.is_nullable &&
			is_struct_type(field_type, status);
		if (class_access_is_struct) {
			if (final_offset > 0) {
				emit_asm(status, `add x0, x0, #${final_offset}\n`);
			}
			return;
		}
		if (field_type === "string" || class_access_field_type?.is_view) {
			emit_string_pair_load_at(status, "x0", final_offset);
			return;
		}
		const size = aarch64_size(field_type);
		const signed = is_signed_type(field_type);
		if (size === 1) {
			emit_asm(
				status,
				signed ? `ldrsb x0, [x0, #${final_offset}]\n` : `ldrb w0, [x0, #${final_offset}]\n`,
			);
		} else if (size === 4) {
			emit_asm(
				status,
				signed ? `ldrsw x0, [x0, #${final_offset}]\n` : `ldr w0, [x0, #${final_offset}]\n`,
			);
		} else {
			emit_asm(status, `ldr x0, [x0, #${final_offset}]\n`);
		}
		return;
	}

	const target_is_ref_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_field" &&
		((node.target as AccessNode).access as AccessFieldNode).type?.is_ref;

	if (target_is_ref_access) {
		build_node(node.target, status);
		ensure_newline(status);
		const final_offset = get_field_offset(access_field.type?.name || "", access_field.name, status);
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed = is_signed_type(field_type);
		if (size === 1) {
			emit_asm(
				status,
				signed ? `ldrsb x0, [x0, #${final_offset}]\n` : `ldrb w0, [x0, #${final_offset}]\n`,
			);
		} else if (size === 4) {
			emit_asm(
				status,
				signed ? `ldrsw x0, [x0, #${final_offset}]\n` : `ldr w0, [x0, #${final_offset}]\n`,
			);
		} else {
			emit_asm(status, `ldr x0, [x0, #${final_offset}]\n`);
		}
		return;
	}

	const target_is_class_var =
		node.target.node_type === "value" &&
		!!status.structs.find((s) => s.name === target_type?.name && s.is_class);

	if (target_is_class_var) {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				emit_asm(status, `mov x0, ${paramReg}\n`);
			}
		} else {
			emit_var_load(status, "x0", name, 8);
		}
		const final_offset = get_field_offset(target_type?.name || "", access_field.name, status);
		// A STRUCT-typed field of a class instance is embedded inline; its
		// "value" is its address (instance + offset) — same convention as the
		// generic field_is_struct path below. Loading a word here would hand
		// consumers the field's first scalar (e.g. Span.index) as a pointer.
		// Prefer the struct's FIELD DECLARATION type: the cached
		// AccessFieldNode.type can be the bare generic (`List`) without its
		// type args, which would miss the monomorphized struct.
		const containing_struct = status.structs.find(
			(s) => s.name === (target_type?.name || "") && !s.is_simple_type,
		);
		const field_decl_type = containing_struct?.fields.find(
			(f) => f.name === access_field.name,
		)?.type;
		const field_type_obj =
			field_decl_type ?? resolve_field_type(access_field, target_type?.name, status);
		// Monomorphize a generic field type (`List<BlockRule>` → `List_BlockRule`)
		// before the struct lookup — the bare generic name isn't in the struct
		// table, so a `List` field would fall through to a scalar load and
		// dereference the value's `_vt` as if it were a pointer.
		const resolved_field_type = field_type_obj?.type_args?.length
			? mono_type_name(field_type_obj)
			: field_type_obj?.name || "";
		const field_is_struct =
			!!resolved_field_type &&
			!field_type_obj?.is_ref &&
			!field_type_obj?.is_nullable &&
			is_struct_type(resolved_field_type, status);
		if (field_is_struct) {
			if (final_offset > 0) {
				emit_asm(status, `add x0, x0, #${final_offset}\n`);
			}
			return;
		}
		const field_type = resolved_field_type;
		// A fat-string FIELD loads as the (ptr, len) pair.
		if (field_type === "string" || field_type_obj?.is_view) {
			emit_string_pair_load_at(status, "x0", final_offset);
			return;
		}
		const size = aarch64_size(field_type);
		const signed = is_signed_type(field_type);
		if (size === 1) {
			emit_asm(
				status,
				signed ? `ldrsb x0, [x0, #${final_offset}]\n` : `ldrb w0, [x0, #${final_offset}]\n`,
			);
		} else if (size === 4) {
			emit_asm(
				status,
				signed ? `ldrsw x0, [x0, #${final_offset}]\n` : `ldr w0, [x0, #${final_offset}]\n`,
			);
		} else {
			emit_asm(status, `ldr x0, [x0, #${final_offset}]\n`);
		}
		return;
	}

	// A nested chain crossing a class-typed field (or a class-typed root)
	// cannot use the summed-offset-from-root load: every pointer hop must be
	// dereferenced. Build the target recursively (which loads each pointer)
	// and read the FINAL field from its result in x0. Value-only chains keep
	// the single base + summed offset below.
	let target_built = false;
	if (node.target.node_type === "access" && access_chain_crosses_class(node, status)) {
		build_node(node.target, status);
		ensure_newline(status);
		offset = get_field_offset(target_type?.name || "", access_field.name, status);
		target_built = true;
	}

	// Get base address into x0
	if (!target_built) {
		if (base.node_type === "value") {
			const name = (base as ValueNode).value;
			const paramReg = get_param_reg(name, status);
			if (paramReg) {
				if (paramReg !== "x0") {
					emit_asm(status, `mov x0, ${paramReg}\n`);
				}
			} else if (is_local_ref_var(name, status)) {
				emit_deref_var_address(status, "x0", name);
			} else {
				emit_var_address(status, "x0", name);
			}
		} else {
			build_node(base, status);
			ensure_newline(status);
		}
	}

	const field_type_obj = resolve_field_type(access_field, target_type?.name, status);
	const resolved_field_type = field_type_obj?.name || "";
	// An enum-with-data field is multi-word (tag + payloads) and lives on the
	// stack like a struct: its "value" is its ADDRESS (consumers blob-copy
	// from it), not the tag word a scalar load would produce.
	const field_is_enum_with_data =
		!!resolved_field_type &&
		!field_type_obj?.is_ref &&
		!!status.enums.find((e) => e.name === resolved_field_type && e.has_associated_data);
	const field_is_struct =
		(!!resolved_field_type &&
			!field_type_obj?.is_ref &&
			!field_type_obj?.is_nullable &&
			is_struct_type(resolved_field_type, status)) ||
		field_is_enum_with_data;

	if (field_is_struct) {
		if (offset > 0) {
			emit_asm(status, `add x0, x0, #${offset}\n`);
		}
		return;
	}

	// A fat-string FIELD is a 16-byte (ptr, len) pair — load both words. A
	// `view T` field is the same pair shape, so it loads identically.
	if (resolved_field_type === "string" || field_type_obj?.is_view) {
		emit_string_pair_load_at(status, "x0", offset);
		return;
	}

	const size = aarch64_size(resolved_field_type);
	const signed = is_signed_type(resolved_field_type);
	if (size === 1) {
		emit_asm(status, signed ? `ldrsb x0, [x0, #${offset}]\n` : `ldrb w0, [x0, #${offset}]\n`);
	} else if (size === 4) {
		emit_asm(status, signed ? `ldrsw x0, [x0, #${offset}]\n` : `ldr w0, [x0, #${offset}]\n`);
	} else {
		emit_asm(status, `ldr x0, [x0, #${offset}]\n`);
	}
}

/**
 * Whether an argument expression is a fat string VALUE: either its static
 * type names `string`, or it is a string literal (whose ValueNode.type may
 * be unset). Literals ride the pair ABI like any string. A `view string`
 * counts too — same pair ABI (see build_function_call_node).
 */
function arg_is_string(node: BaseNode): boolean {
	const v = node as { value?: string };
	if (node.node_type === "value" && typeof v.value === "string" && v.value.startsWith('"')) {
		return true;
	}
	const t = type_from_value_node(node);
	return t?.name === "string" && !t.is_array;
}

/**
 * Whether every known (non-generic) conformer of `trait` implements `method`
 * as an owned-heap string return, per the stamped classification. The dynamic
 * dispatch result is then owned regardless of which conformer runs, so the
 * caller takes the concrete-call path (dup + free the original). Anything
 * else — a borrow-returning or unclassified conformer, or none at all —
 * keeps the borrow treatment.
 */
function trait_method_all_conformers_owned(
	trait: { name: string },
	method_name: string,
	status: BuildStatus,
): boolean {
	const conformers = status.structs.filter(
		(s) => !s.is_generic && (s.traits ?? []).includes(trait.name),
	);
	if (conformers.length === 0) return false;
	for (const s of conformers) {
		const m = s.functions.find((f) => f.name === method_name);
		if (
			!m ||
			m.return_type?.name !== "string" ||
			m.return_type?.is_view ||
			m.returns_string_borrow !== false
		) {
			return false;
		}
	}
	return true;
}

function build_access_method(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
) {
	let target_type = type_from_value_node(node.target);
	if (!target_type?.name && node.target.node_type === "access") {
		const resolved = resolve_access_type(node.target as AccessNode, status);
		if (resolved) target_type = resolved;
	}
	if (!target_type?.name && node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		if (name === "self" && status.current_struct) {
			target_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(name)) {
			target_type = status.variable_types.get(name)!;
		} else {
			const decl = status.scoped_declarations.findLast((d) => d.name === name);
			if (decl?.type?.name) {
				target_type = decl.type;
			}
		}
	}
	const target_name =
		node.target.node_type === "value" ? (node.target as ValueNode).value : target_type?.name;
	const enum_node = find_enum(target_type?.name, status) ?? find_enum(target_name, status);
	// Borrow-position `to_string()` elision (STRING_PLAN tranche 3): the
	// checker verified the consumer takes the receiver's bytes as a plain
	// `string` borrow and cannot mutate them — pass the receiver's (ptr, len)
	// pair straight through instead of calling `string_to_string` (strdup) and
	// freeing the temporary. The result is NOT an owned heap temp.
	if (
		access_func.borrow_to_string &&
		target_type?.name === "string" &&
		!target_type.is_view &&
		!target_type.is_array
	) {
		build_node(node.target, status);
		ensure_newline(status);
		status.last_result_is_heap = false;
		return;
	}
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === access_func.name);
		if (enum_case) {
			const case_index = enum_node.cases.indexOf(enum_case);
			if (enum_node.has_associated_data) {
				const enum_size = get_enum_size(target_name!, status);
				const temp_name = `_enum_${access_temp_counter++}`;
				const temp_offset = allocate_stack_space(status, enum_size);
				status.stack_offsets!.set(temp_name, temp_offset);
				// An owned class/trait LOCAL passed to an owning case payload
				// transfers ownership (check records the arg in
				// move_param_indices): mark it moved so its own scope-exit
				// destroy doesn't free the instance the payload now owns.
				if (access_func.move_param_indices?.length) {
					for (const idx of access_func.move_param_indices) {
						mark_moved_if_struct(access_func.params[idx], status);
					}
				}
				emit_asm(status, `add x0, x29, #${temp_offset}\n`);
				emit_asm(status, `mov x1, #${case_index}\n`);
				emit_asm(status, `str x1, [x0]\n`);
				let payload_offset = 8;
				for (let i = access_func.params.length - 1; i >= 0; i--) {
					build_node(access_func.params[i], status);
					ensure_newline(status);
					const param_type_name = enum_case.params[i].type.name;
					const param_size = aarch64_size(param_type_name);
					const abs_offset = temp_offset + payload_offset;
					if (param_type_name === "string") {
						// A string payload is an OWNED copy: strdup the (ptr,
						// len) pair the arg built, then store both halves —
						// the enum value outlives the producer's local, and
						// the scope-exit payload free needs a heap ptr.
						emit_strdup_string(status);
						emit_asm(status, `str x0, [x29, #${abs_offset}]\n`);
						emit_asm(status, `str x1, [x29, #${abs_offset + 8}]\n`);
					} else if (param_size === 1) {
						emit_asm(status, `strb w0, [x29, #${abs_offset}]\n`);
					} else if (param_size === 4) {
						emit_asm(status, `str w0, [x29, #${abs_offset}]\n`);
					} else {
						emit_asm(status, `str x0, [x29, #${abs_offset}]\n`);
					}
					payload_offset += param_size;
				}
				emit_asm(status, `add x0, x29, #${temp_offset}\n`);
			} else {
				emit_asm(status, `mov x0, #${case_index}\n`);
			}
			return;
		}
	}

	if (
		access_func.name === "to_string" &&
		(status.enums.find((e) => e.name === target_type.name) ||
			status.bitsets.find((b) => b.name === target_type.name))
	) {
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const paramReg = get_param_reg(name, status);
			if (paramReg) {
				if (paramReg !== "x0") {
					emit_asm(status, `mov x0, ${paramReg}\n`);
				}
			} else {
				emit_var_address(status, "x0", name);
			}
			emit_asm(status, `ldr x0, [x0]\n`);
		} else {
			build_node(node.target, status);
			ensure_newline(status);
		}
		emit_asm(status, `bl int_to_string\n`);
		status.last_result_is_heap = true;
		return;
	}

	if (
		access_func.name === "to_string" &&
		target_type.is_array &&
		target_type.name === "char" &&
		target_type.length
	) {
		build_char_array_to_string(node, (target_type.length as ValueNode).value, status);
		status.last_result_is_heap = true;
		return;
	}

	if (access_func.name === "to_string" && target_type.is_array && target_type.length) {
		build_int_array_to_string(node, target_type, status);
		status.last_result_is_heap = true;
		return;
	}

	// Inline array .at() and .set() to use element-size-aware load/store
	// Only inline for: value targets (not class arrays) and fixed-size struct field targets
	if (target_type.is_array && (access_func.name === "at" || access_func.name === "set")) {
		const elem_type_name = target_type.name;
		const elem_struct = status.structs.find((s) => s.name === elem_type_name && !s.is_simple_type);
		const is_struct_field_target =
			node.target.node_type === "access" &&
			(node.target as AccessNode).access.node_type === "access_field";
		// Fixed-size fields have a length with a real source position (start >= 0).
		// Dynamic arrays (e.g. constructed at runtime) use length.start = -1 and are stored
		// as a pointer to heap data, so they can't be inlined like inline array fields.
		const length_has_source = !!target_type.length && (target_type.length.start ?? -1) >= 0;
		const is_fixed_size_field = is_struct_field_target && length_has_source;
		const can_inline =
			!elem_struct?.is_class && (node.target.node_type === "value" || is_fixed_size_field);
		if (can_inline) {
			const elem_size = elem_struct
				? get_struct_size(elem_type_name, status)
				: aarch64_size(elem_type_name);
			const elem_signed =
				!elem_struct && is_signed_int_type(elem_type_name) && type_bits(elem_type_name) === 64;

			// The inlined .at()/.set() below uses x9 (caller-saved scratch) for
			// the array base, avoiding the per-access x19 save/restore overhead.
			// For .at() (loads), the index is evaluated first into x1, then the
			// base is computed into x9 (doesn't clobber x1). For .set() (stores),
			// when both index and value are simple value nodes (literals/vars) on
			// a value-target array, the same x9 fast path applies: the base is
			// built into x9 first, then index→x1 and value→x2 (simple value builds
			// only write x0, so x9/x1 survive). Otherwise .set() falls back to the
			// x19 save/restore path because evaluating a non-simple value can
			// clobber caller-saved registers.
			const use_fast_path = access_func.name === "at";
			const set_fast =
				access_func.name === "set" &&
				!elem_struct &&
				access_func.params.length > 1 &&
				access_func.params[0].node_type === "value" &&
				access_func.params[1].node_type === "value" &&
				node.target.node_type === "value";

			const elem_is_fat_string =
				elem_type_name === "string" && !elem_struct && !target_type.is_view;
			if (set_fast) {
				// .set() fast path: base → x9, index → x1, value → x2, store.
				// Base is built first so a param-register base (e.g. an array
				// passed in x1) is read before x1 is overwritten by the index.
				const name = (node.target as ValueNode).value;
				const paramReg = get_param_reg(name, status);
				if (paramReg) {
					emit_asm(status, `mov x9, ${paramReg}\n`);
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x9", name);
				} else if (status.heap_array_vars?.has(name)) {
					emit_var_address(status, "x9", name);
					emit_asm(status, `ldr x9, [x9]\n`);
					emit_asm(status, `add x9, x9, #8\n`);
				} else if (
					status.function_array_params?.has(name) ||
					status.function_variadic_params?.has(name)
				) {
					emit_var_address(status, "x9", name);
					emit_asm(status, `ldr x9, [x9]\n`);
				} else {
					emit_var_address(status, "x9", name);
				}
				if (elem_is_fat_string) {
					// Deep-copy semantics: free the outgoing ptr, strdup the
					// incoming one, carry the len half. A string VALUE build
					// emits the (ptr, len) PAIR — x0 AND x1 — so evaluate the
					// value FIRST, spill it, then build the index into x1.
					// The slot address (x9) and incoming pair (x2/x3) are all
					// caller-saved — park them in x19-x21 across the
					// free/strdup calls.
					build_node(access_func.params[1], status);
					ensure_newline(status);
					const val_spill = allocate_stack_space(status, 16, 16);
					emit_pair_store_x29(status, val_spill);
					build_operand(access_func.params[0], "x1", status);
					ensure_newline(status);
					emit_pair_load_x29(status, val_spill, "x2", "x3");
					emit_asm(status, `stp x19, x20, [sp, #-16]!\n`);
					emit_asm(status, `stp x21, x22, [sp, #-16]!\n`);
					emit_asm(status, `mov x20, x2\n`);
					emit_asm(status, `mov x21, x3\n`);
					emit_asm(status, `lsl x10, x1, #4\n`);
					emit_asm(status, `add x19, x9, x10\n`);
					emit_asm(status, `ldr x0, [x19]\n`);
					emit_free(status);
					emit_asm(status, `mov x0, x20\n`);
					emit_strdup(status);
					emit_asm(status, `str x0, [x19]\n`);
					emit_asm(status, `str x21, [x19, #8]\n`);
					emit_asm(status, `ldp x21, x22, [sp], #16\n`);
					emit_asm(status, `ldp x19, x20, [sp], #16\n`);
					return;
				}
				// index → x1
				build_operand(access_func.params[0], "x1", status);
				ensure_newline(status);
				// value → x2 (simple value node: build only writes x0)
				build_node(access_func.params[1], status);
				ensure_newline(status);
				emit_asm(status, `mov x2, x0\n`);
				// store
				if (elem_size === 8) {
					emit_asm(status, `str x2, [x9, x1, lsl #3]\n`);
				} else {
					emit_asm(status, `mov x3, #${elem_size}\n`);
					emit_asm(status, `mul x1, x1, x3\n`);
					if (elem_size === 1) {
						emit_asm(status, `strb w2, [x9, x1]\n`);
					} else if (elem_size === 2) {
						emit_asm(status, `strh w2, [x9, x1]\n`);
					} else if (elem_size === 4) {
						emit_asm(status, `str w2, [x9, x1]\n`);
					} else {
						emit_asm(status, `str x2, [x9, x1]\n`);
					}
				}
				return;
			}

			if (use_fast_path) {
				// Fixed-array pipeline: a repeated (array, index) pair reads
				// its pinned element-address register instead of re-deriving
				// the whole address per access.
				const licm_key =
					elem_struct && status.function_return_label
						? fixed_array_cache_key(node, access_func, status)
						: null;
				if (licm_key) {
					const cached = status.array_ptr_cache?.get(licm_key);
					if (cached) {
						emit_asm(status, `mov x0, ${cached}\n`);
						status.at_addr_reg = cached;
						return;
					}
				}
				// .at(): evaluate index → x1 (build_operand: promoted vars/
				// literals emit 1 instruction), compute base → x9, load
				if (access_func.params.length > 0) {
					build_operand(access_func.params[0], "x1", status);
					ensure_newline(status);
				}
				// Build target (array base) into x9
				if (node.target.node_type === "value") {
					const name = (node.target as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						emit_asm(status, `mov x9, ${paramReg}\n`);
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x9", name);
					} else if (status.heap_array_vars?.has(name)) {
						emit_var_address(status, "x9", name);
						emit_asm(status, `ldr x9, [x9]\n`);
						emit_asm(status, `add x9, x9, #8\n`);
					} else if (
						status.function_array_params?.has(name) ||
						status.function_variadic_params?.has(name)
					) {
						emit_var_address(status, "x9", name);
						emit_asm(status, `ldr x9, [x9]\n`);
					} else {
						emit_var_address(status, "x9", name);
					}
				} else if (is_fixed_size_field) {
					const inner_access = node.target as AccessNode;
					const inner_field = inner_access.access as AccessFieldNode;
					const inner_base = inner_access.target;
					const inner_target_type = type_from_value_node(inner_base);
					const field_offset = get_field_offset(
						inner_target_type?.name || "",
						inner_field.name,
						status,
					);
					if (inner_base.node_type === "value") {
						const base_name = (inner_base as ValueNode).value;
						const bpReg = get_param_reg(base_name, status);
						if (bpReg) {
							emit_asm(status, `mov x9, ${bpReg}\n`);
						} else if (is_local_ref_var(base_name, status)) {
							emit_deref_var_address(status, "x9", base_name);
						} else {
							emit_var_address(status, "x9", base_name);
						}
					} else {
						build_node(inner_base, status);
						ensure_newline(status);
						emit_asm(status, `mov x9, x0\n`);
					}
					if (field_offset > 0) {
						emit_asm(status, `add x9, x9, #${field_offset}\n`);
					}
				}
				// Load element
				if (elem_struct) {
					// Fill the fixed-array pipeline: pin `base + i*stride` in
					// a callee-saved register, then hand the address out
					// through x0 (the .at() contract) and the consume-once
					// marker for the following field hop.
					if (licm_key && alloc_array_cache_reg(status) !== null) {
						const reg = alloc_array_cache_reg(status)!;
						if ((elem_size & (elem_size - 1)) === 0) {
							emit_asm(status, `add ${reg}, x9, x1, lsl #${Math.log2(elem_size)}\n`);
						} else {
							emit_asm(status, `mov x2, #${elem_size}\n`);
							emit_asm(status, `mul x1, x1, x2\n`);
							emit_asm(status, `add ${reg}, x9, x1\n`);
						}
						emit_asm(status, `mov x0, ${reg}\n`);
						if (!status.array_ptr_cache) status.array_ptr_cache = new Map();
						status.array_ptr_cache.set(licm_key, reg);
						if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
						status.callee_saved_regs_used.add(reg);
						status.at_addr_reg = reg;
						return;
					}
					if (elem_size === 8) {
						emit_asm(status, `add x0, x9, x1, lsl #3\n`);
					} else {
						emit_asm(status, `mov x2, #${elem_size}\n`);
						emit_asm(status, `mul x1, x1, x2\n`);
						emit_asm(status, `add x0, x9, x1\n`);
					}
				} else if (elem_is_fat_string) {
					// Fat-string element: load the (ptr, len) pair.
					emit_asm(status, `add x0, x9, x1, lsl #4\n`);
					emit_asm(status, `ldp x0, x1, [x0]\n`);
				} else {
					if (elem_size === 8) {
						emit_asm(status, `ldr x0, [x9, x1, lsl #3]\n`);
					} else {
						emit_asm(status, `mov x2, #${elem_size}\n`);
						emit_asm(status, `mul x1, x1, x2\n`);
						if (elem_size === 1) {
							emit_asm(status, elem_signed ? `ldrsb x0, [x9, x1]\n` : `ldrb w0, [x9, x1]\n`);
						} else if (elem_size === 2) {
							emit_asm(status, elem_signed ? `ldrsh x0, [x9, x1]\n` : `ldrh w0, [x9, x1]\n`);
						} else if (elem_size === 4) {
							emit_asm(status, elem_signed ? `ldrsw x0, [x9, x1]\n` : `ldr w0, [x9, x1]\n`);
						} else {
							emit_asm(status, `ldr x0, [x9, x1]\n`);
						}
					}
				}
				return;
			}

			// .set(): still uses x19 save/restore (both index and value params)
			emit_asm(status, `str x19, [sp, #-16]!\n`);

			// Build target (array pointer) into x19
			if (node.target.node_type === "value") {
				const name = (node.target as ValueNode).value;
				const paramReg = get_param_reg(name, status);
				if (paramReg) {
					emit_asm(status, `mov x19, ${paramReg}\n`);
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x19", name);
				} else if (status.heap_array_vars?.has(name)) {
					// Heap-allocated array: variable stores a heap pointer with an 8-byte
					// length prefix. Dereference and skip the prefix to get the first element.
					emit_var_address(status, "x19", name);
					emit_asm(status, `ldr x19, [x19]\n`);
					emit_asm(status, `add x19, x19, #8\n`);
				} else if (
					status.function_array_params?.has(name) ||
					status.function_variadic_params?.has(name)
				) {
					// Array passed as a param: variable stores a pointer to raw data (no prefix)
					emit_var_address(status, "x19", name);
					emit_asm(status, `ldr x19, [x19]\n`);
				} else {
					// Local var/const array: data is inline, emit_var_address points to first element
					emit_var_address(status, "x19", name);
				}
			} else if (is_fixed_size_field) {
				// Fixed-size struct field array (e.g., h.args.at(0)): compute field address
				const inner_access = node.target as AccessNode;
				const inner_field = inner_access.access as AccessFieldNode;
				const inner_base = inner_access.target;
				const inner_target_type = type_from_value_node(inner_base);
				const field_offset = get_field_offset(
					inner_target_type?.name || "",
					inner_field.name,
					status,
				);

				if (inner_base.node_type === "value") {
					const base_name = (inner_base as ValueNode).value;
					emit_var_address(status, "x19", base_name);
				} else {
					build_node(inner_base, status);
					ensure_newline(status);
					emit_asm(status, `mov x19, x0\n`);
				}
				if (field_offset > 0) {
					emit_asm(status, `add x19, x19, #${field_offset}\n`);
				}
			}
			// Build index argument into x1 (promoted vars/literals emit 1
			// instruction via build_operand's direct paths)
			if (access_func.params.length > 0) {
				build_operand(access_func.params[0], "x1", status);
				ensure_newline(status);
			}

			if (access_func.name === "at") {
				if (elem_struct) {
					// Struct element: compute address (base + index * elem_size), return pointer
					if (elem_size === 8) {
						emit_asm(status, `add x0, x19, x1, lsl #3\n`);
					} else {
						emit_asm(status, `mov x2, #${elem_size}\n`);
						emit_asm(status, `mul x1, x1, x2\n`);
						emit_asm(status, `add x0, x19, x1\n`);
					}
				} else if (elem_is_fat_string) {
					// Fat-string element: load the (ptr, len) pair.
					emit_asm(status, `add x9, x19, x1, lsl #4\n`);
					emit_asm(status, `ldp x0, x1, [x9]\n`);
				} else {
					// Simple element: compute offset and load value
					if (elem_size === 8) {
						emit_asm(status, `ldr x0, [x19, x1, lsl #3]\n`);
					} else {
						emit_asm(status, `mov x2, #${elem_size}\n`);
						emit_asm(status, `mul x1, x1, x2\n`);
						if (elem_size === 1) {
							emit_asm(status, elem_signed ? `ldrsb x0, [x19, x1]\n` : `ldrb w0, [x19, x1]\n`);
						} else if (elem_size === 2) {
							emit_asm(status, elem_signed ? `ldrsh x0, [x19, x1]\n` : `ldrh w0, [x19, x1]\n`);
						} else if (elem_size === 4) {
							emit_asm(status, elem_signed ? `ldrsw x0, [x19, x1]\n` : `ldr w0, [x19, x1]\n`);
						} else {
							emit_asm(status, `ldr x0, [x19, x1]\n`);
						}
					}
				}
			} else {
				// set(): build value into x2, compute offset and store
				if (access_func.params.length > 1) {
					const value_param = access_func.params[1];
					if (elem_struct && value_param.node_type === "value") {
						// Struct element: the store memcpy's elem_size bytes
						// FROM the value's ADDRESS — a plain build_node would
						// load the first 8 bytes instead of taking the
						// address (struct params/locals travel by reference;
						// see the struct-arg pattern in the inline-method
						// call site below).
						const vname = (value_param as ValueNode).value;
						const vReg = get_param_reg(vname, status);
						if (vReg) {
							emit_asm(status, `mov x2, ${vReg}\n`);
						} else if (is_local_ref_var(vname, status)) {
							emit_deref_var_address(status, "x2", vname);
						} else {
							emit_var_address(status, "x2", vname);
						}
					} else {
						build_node(value_param, status);
						ensure_newline(status);
						emit_asm(status, `mov x2, x0\n`);
					}
				}
				if (elem_is_fat_string) {
					// Deep-copy semantics: free the outgoing ptr, strdup the
					// incoming one, carry the len half. x19 base, x1 index,
					// value pair in (x2, x3).
					emit_asm(status, `stp x20, x21, [sp, #-16]!\n`);
					emit_asm(status, `lsl x21, x1, #4\n`);
					emit_asm(status, `add x9, x19, x21\n`);
					emit_asm(status, `ldr x0, [x9]\n`);
					emit_free(status);
					emit_asm(status, `mov x0, x2\n`);
					emit_strdup(status);
					emit_asm(status, `str x0, [x9]\n`);
					emit_asm(status, `str x3, [x9, #8]\n`);
					emit_asm(status, `ldp x20, x21, [sp], #16\n`);
					return;
				}
				if (elem_struct) {
					// Struct element: x2 is address of value, memcpy to computed address
					if (elem_size === 8) {
						emit_asm(status, `add x0, x19, x1, lsl #3\n`);
					} else {
						emit_asm(status, `mov x3, #${elem_size}\n`);
						emit_asm(status, `mul x1, x1, x3\n`);
						emit_asm(status, `add x0, x19, x1\n`);
					}
					emit_asm(status, `mov x1, x2\n`);
					emit_asm(status, `mov x2, #${elem_size}\n`);
					emit_asm(status, `bl _memcpy\n`);
				} else {
					if (elem_size === 8) {
						emit_asm(status, `str x2, [x19, x1, lsl #3]\n`);
					} else {
						emit_asm(status, `mov x3, #${elem_size}\n`);
						emit_asm(status, `mul x1, x1, x3\n`);
						if (elem_size === 1) {
							emit_asm(status, `strb w2, [x19, x1]\n`);
						} else if (elem_size === 2) {
							emit_asm(status, `strh w2, [x19, x1]\n`);
						} else if (elem_size === 4) {
							emit_asm(status, `str w2, [x19, x1]\n`);
						} else {
							emit_asm(status, `str x2, [x19, x1]\n`);
						}
					}
				}
			}
			emit_asm(status, `ldr x19, [sp], #16\n`);
			return;
		}
	}

	// Inline Buffer.load_int/store_int/load/store/load_float/store_float
	// to direct strided loads/stores, bypassing the inline-method expansion
	// overhead (self save/restore + x19 save/restore = ~5 extra instructions
	// per access). This is the single biggest codegen win for array-heavy
	// benchmarks (nsieve, knucleotide, spectral-norm, lru).
	//
	// Match both the generic name ("Buffer") and monomorphized names
	// ("Buffer_int", "Buffer_uint32", ...): a `Buffer<T>` field's resolved
	// type is the specialized struct, so checking only "Buffer" would miss
	// every `Buffer<int>` access and emit a `bl Buffer_int_load_int` call
	// instead of an inlined strided load (a major slowdown for BigInt).
	if (target_type.name === "Buffer" || target_type.name.startsWith("Buffer_")) {
		const method = access_func.name;

		// Invalidate data-pointer cache when a resize/alloc method is called
		// on a Buffer — realloc may move the data pointer, making any cached
		// value in a callee-saved register stale.
		const resize_methods = new Set([
			"grow_int",
			"grow_u32",
			"grow",
			"grow_float",
			"alloc_int",
			"alloc_u32",
			"alloc",
			"alloc_float",
		]);
		if (resize_methods.has(method) && status.buffer_data_cache) {
			const t = node.target;
			let key: string | null = null;
			if (t.node_type === "value") {
				key = (t as ValueNode).value;
			} else if (
				t.node_type === "access" &&
				(t as AccessNode).access.node_type === "access_field"
			) {
				const inner = t as AccessNode;
				if (inner.target.node_type === "value") {
					key = `${(inner.target as ValueNode).value}.${(inner.access as AccessFieldNode).name}`;
				}
			}
			if (key) status.buffer_data_cache.delete(key);
		}

		const buffer_load_methods = new Set(["load_int", "load_u32", "load_float"]);
		const buffer_store_methods = new Set(["store_int", "store_u32", "store_float", "store_or_int"]);
		const is_buf_load = buffer_load_methods.has(method);
		const is_buf_store = buffer_store_methods.has(method);

		if (is_buf_load || is_buf_store) {
			// Element size: load_u32/store_u32 = 4 bytes (uint32),
			// load_int/store_int/load_float/store_float/store_or_int = 8 bytes
			// (long/double). store_or_int treats data as long* (8-byte stride,
			// see Buffer.nm).
			const elem_bytes = method === "load_u32" || method === "store_u32" ? 4 : 8;
			const shift = elem_bytes === 8 ? 3 : 2;
			const is_float = method === "load_float" || method === "store_float";

			if (is_buf_load) {
				// Base-folded addressing (ASM_PLAN_6 tranche 3): a folded
				// receiver pin replaces BOTH the index staging and the data
				// derivation — the access indexes the preloaded fold
				// register with the bare induction.
				let data_reg: string;
				const folded =
					!is_float && elem_bytes === 8 && access_func.params.length > 0
						? lookup_buffer_fold(node.target, access_func.params[0], status)
						: null;
				let load_index_reg = "x1";
				if (folded) {
					load_index_reg = folded.var_reg;
					data_reg = folded.reg;
				} else {
					if (access_func.params.length > 0) {
						load_index_reg = staged_index_reg(access_func.params[0], status);
					}
					data_reg = staged_data_reg(node.target, buffer_cache_key(node.target), status, () =>
						get_buffer_data_ptr(node.target, status),
					);
				}
				// Strided load
				if (is_float) {
					// `load_float` leaves its result in d0. The default Nomen calling
					// convention routes every value through x0, so for ordinary
					// consumers (assignments, function args, comparisons, statement-
					// level expressions) we must emit `fmov x0, d0`. Only when the
					// immediate caller is `build_float_operand` requesting the d0
					// fast path (`status.float_result_in_d0 == true`) can we leave
					// the result in d0 and consume the flag — otherwise the caller
					// would read a stale x0 (e.g. the index register) and silently
					// produce `nan`, which was the pre-existing spectral-norm bug.
					const caller_wants_d0 = status.float_result_in_d0 ?? false;
					status.float_result_in_d0 = false;
					emit_asm(status, `ldr d0, [${data_reg}, ${load_index_reg}, lsl #${shift}]\n`);
					if (!caller_wants_d0) {
						emit_asm(status, `fmov x0, d0\n`);
					}
				} else if (elem_bytes === 8) {
					emit_asm(status, `ldr x0, [${data_reg}, ${load_index_reg}, lsl #3]\n`);
				} else {
					emit_asm(status, `ldr w0, [${data_reg}, ${load_index_reg}, lsl #2]\n`);
				}
			} else {
				// Store: evaluate value (→x2), index (→x1) — value first so a
				// complex index eval can't clobber it, then no spill needed
				// unless both are complex. Access staging (ASM_PLAN_3 tranche L)
				// forwards a `_param_N` value temp's tree at the read — a no-op
				// int cast unwraps so a promoted source moves straight to x2.
				const value_forwarded = forwarded_param_tree(access_func.params[1], status);
				const value_node = value_forwarded
					? unwrap_noop_int_cast(value_forwarded)
					: access_func.params[1];
				build_operand(value_node, "x2", status);
				ensure_newline(status);
				// Base-folded addressing (ASM_PLAN_6 tranche 3): a folded
				// receiver pin replaces the index staging and the data
				// derivation — the value (already staged in x2) stores
				// straight off the fold register with the bare induction.
				const store_folded =
					!is_float && elem_bytes === 8 && method === "store_int" && access_func.params.length > 0
						? lookup_buffer_fold(node.target, access_func.params[0], status)
						: null;
				let store_index_reg = "x1";
				if (store_folded) {
					store_index_reg = store_folded.var_reg;
				} else {
					store_index_reg = staged_index_reg(access_func.params[0], status);
				}
				// Get data pointer (cached, pinned, or freshly loaded)
				const data_reg = store_folded
					? store_folded.reg
					: staged_data_reg(node.target, buffer_cache_key(node.target), status, () =>
							get_buffer_data_ptr(node.target, status),
						);
				// Strided store
				if (method === "store_or_int") {
					if (elem_bytes === 8) {
						emit_asm(status, `ldr x0, [${data_reg}, ${store_index_reg}, lsl #3]\n`);
						emit_asm(status, `orr x2, x0, x2\n`);
						emit_asm(status, `str x2, [${data_reg}, ${store_index_reg}, lsl #3]\n`);
					} else {
						emit_asm(status, `ldr w0, [${data_reg}, ${store_index_reg}, lsl #2]\n`);
						emit_asm(status, `orr w2, w0, w2\n`);
						emit_asm(status, `str w2, [${data_reg}, ${store_index_reg}, lsl #2]\n`);
					}
				} else if (is_float) {
					// The value was built via build_node and moved to x2 as a raw
					// 64-bit bit pattern (the default convention). Store from x2 —
					// NOT d0, which holds whatever stale float a prior op left
					// behind. (Pre-existing latent bug masked by d0 usually
					// happening to still hold the right value.)
					emit_asm(status, `str x2, [${data_reg}, ${store_index_reg}, lsl #${shift}]\n`);
				} else if (elem_bytes === 8) {
					emit_asm(status, `str x2, [${data_reg}, ${store_index_reg}, lsl #3]\n`);
				} else {
					emit_asm(status, `str w2, [${data_reg}, ${store_index_reg}, lsl #2]\n`);
				}
			}
			return;
		}
	}

	let mono_struct_name = target_type.is_array
		? "Array_" + target_type.name
		: mono_type_name(target_type);
	// Static calls on a generic type without explicit type args (e.g.
	// `Array.with(0, n)`) resolve to the generic name (`Array`), for which no
	// monomorphized struct exists. Find the specialized struct that actually
	// defines the method (e.g. `Array_int`), mirroring the C backend.
	if (
		!access_func.mangled_name &&
		mono_struct_name &&
		!status.structs.find((s) => s.name === mono_struct_name && !s.is_generic)
	) {
		const specialized = status.structs.find(
			(s) =>
				s.name.startsWith(mono_struct_name + "_") &&
				!s.is_generic &&
				s.functions.find((f) => f.name === access_func.name),
		);
		if (specialized) mono_struct_name = specialized.name;
	}
	const method_name =
		access_func.mangled_name || `${mono_struct_name}_${access_func.name.replace(/#/g, "")}`;

	// A `ref self` method (e.g. string.set) receives the caller's slot BY
	// ADDRESS — the same convention the plain-function ref-param path uses —
	// so the callee can write back through it. Simple-type receivers must
	// therefore skip the usual "pass the value" load.
	const method_self_is_ref = !!status.structs
		.find((s) => s.name === mono_struct_name && !s.is_generic)
		?.functions.find((f) => f.name === access_func.name)
		?.params?.some((p) => p.is_self_param && (p.is_ref || p.type?.is_ref));
	// The concrete callee (struct method, else the trait method a trait-typed
	// receiver would dispatch to) — signature source for the inline-lambda
	// argument scan below.
	const access_callee_method =
		status.structs
			.find((s) => s.name === mono_struct_name && !s.is_generic)
			?.functions.find((f) => f.name === access_func.name) ??
		status.traits
			.find((t) => t.name === target_type.name)
			?.functions.find((f) => f.name === access_func.name);
	const access_callee_params = access_callee_method?.params?.filter((p) => !p.is_self_param);

	// Check if method returns a struct. A `view T` return is a (ptr, len) pair
	// in x0/x1, not a sret struct — exclude views even when T is a struct.
	// An ARRAY-typed return (`out Array<T>`, e.g. `with`/`add`/`mul`) is a
	// heap buffer POINTER in x0, never an sret struct — even when the element
	// T is itself a struct (the element name would otherwise match below).
	// An enum-with-data return uses sret like a struct (see build_function_node).
	const return_struct =
		!access_func.type.is_view &&
		!access_func.type.is_array &&
		(!!status.structs.find(
			(s) => s.name === access_func.type.name && !s.is_simple_type && !s.is_class,
		) ||
			get_enum_sret_size(access_func.type.name, status) !== undefined);

	let temp_addr = "";
	let temp_offset = 0;
	if (return_struct) {
		const return_enum_size = get_enum_sret_size(access_func.type.name, status);
		temp_addr = `_access_temp_${access_temp_counter++}`;
		temp_offset = allocate_stack_space(
			status,
			return_enum_size ?? get_struct_size(access_func.type.name, status),
		);
		status.stack_offsets!.set(temp_addr, temp_offset);
		emit_asm(status, `add x8, x29, #${temp_offset}\n`);
	}

	// A fat-STRING receiver is a (ptr, len) value: build it into the x0/x1
	// pair and start argument registers at slot 2 (the pair occupies slots
	// 0 and 1). This early path bypasses the struct-oriented receiver logic
	// below — string receivers are simple values (locals, params, fields,
	// call results).
	const receiver_is_string =
		!access_func.is_static &&
		target_type?.name === "string" &&
		// A `view string` receiver rides the SAME (ptr, len) pair ABI as an
		// owned string — the pair path below builds it into x0/x1 either
		// way. Excluding views here collapsed the pair to one slot (the
		// length was dropped and every following arg shifted down a
		// register), silently corrupting e.g. `view.slice(s, e)` calls.
		// A string ARRAY (`string[N]` / heap `Array<string>`) is typed
		// name="string" but its methods take ONE pointer slot (first-element
		// convention), not the fat pair.
		!target_type.is_array &&
		// A `ref self` method (string.set) takes &slot — one pointer, not
		// the fat pair.
		!method_self_is_ref;
	let frees_string_receiver = false;
	// A consuming `move out string` call (`string_to_string`, the identity
	// until the signature flipped to a real strdup) receives a COPY of the
	// receiver's storage. When that receiver is itself a temporary OWNING
	// allocation (`f().to_string()`, `(a + b).to_string()`), the original
	// temp must be freed once the callee has copied it — mirroring the C
	// backend's statement-expression. Bare vars/fields/literals are NOT
	// freed (their owner outlives the call); borrow-returning callees are
	// excluded too.
	if (receiver_is_string) {
		// Build the receiver pair, tracking whether it produced an OWNING
		// heap temp (`f(...)`, a concat, a move-out call). Reset-first mirrors
		// emit_string_length: the flag reflects exactly this expression.
		status.last_result_is_heap = false;
		build_node(node.target, status);
		ensure_newline(status);
		// A consuming `move out string` call (`string_to_string`, the identity
		// until the signature flipped to a real strdup) copies the receiver's
		// storage — when that receiver is itself an owning temp, the original
		// must be freed once the copy exists (mirroring the C backend's
		// statement-expression). Borrows/literals/vars leave the flag false.
		frees_string_receiver = method_name === "string_to_string" && status.last_result_is_heap;
		status.last_result_is_heap = false;
		// Pair now in x0/x1. Save both halves across argument evaluation.
		emit_asm(status, `stp x0, x1, [sp, #-16]!\n`);
	}

	// Deferred self (ASM_PLAN_2 tranche H — call-site operand-home
	// marshalling): a receiver whose value already lives in a CALLEE-SAVED
	// register (param x19-x28) needs no push/pop round-trip — a callee-saved
	// register survives every argument evaluation (calls inside arguments
	// clobber caller-saved x0-x18 only), so the `mov x0, <reg>` defers to
	// just before the bl. The code string is captured at receiver-resolution
	// time and emitted after the argument loop.
	let deferred_self_code: string | null = null;
	// Deferred leaf arguments: a scalar leaf (literal / variable read with a
	// single-instruction materialization) can be built DIRECTLY into its slot
	// register after every evaluation — no `build_node → x0 → mov xN, x0`
	// shuffle. A named leaf defers only when every sibling argument is
	// call-free: deferral moves the read past the siblings' evaluation, and a
	// call could (through an inline expansion) mutate an observable value.
	const deferred_args: { param: BaseNode; slot: number }[] = [];

	if (!access_func.is_static && !receiver_is_string) {
		// Instance method: load target into x0 (self)
		// For simple types, pass value; for structs/traits, pass address.
		// A trait-typed receiver is treated like a struct: its concrete storage
		// (local) is addressed, and a trait param (saved in a callee-saved reg)
		// already holds the struct pointer — either way x0 ends up pointing at
		// the struct whose vtable lives at offset 0.
		const target_is_simple =
			!status.structs.find((s) => s.name === target_type.name && !s.is_simple_type) &&
			!status.traits.find((t) => t.name === target_type.name);
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const paramReg = get_param_reg(name, status);
			const is_literal_value =
				/^(\+|-)?\d+(\.\d+)?$/.test(name) || name === "true" || name === "false";
			if (paramReg) {
				// Callee-saved param registers survive argument evaluation —
				// defer the self load past the arg loop (no push/pop).
				if (paramReg !== "x0" && /^x(?:19|2[0-8])$/.test(paramReg)) {
					deferred_self_code = `mov x0, ${paramReg}\n`;
				} else if (paramReg !== "x0") {
					emit_asm(status, `mov x0, ${paramReg}\n`);
				}
			} else if (is_literal_value || (name.startsWith("'") && name.endsWith("'"))) {
				build_node(node.target, status);
				ensure_newline(status);
			} else {
				const has_stack_offset = status.stack_offsets?.has(name);
				if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
				// Heap-allocated arrays store a heap pointer with an 8-byte length prefix.
				// Function array params store a pointer to raw data (no prefix).
				if (
					target_type.is_array &&
					status.heap_array_vars?.has(name) &&
					!is_local_ref_var(name, status)
				) {
					emit_asm(status, `ldr x0, [x0]\n`);
					emit_asm(status, `add x0, x0, #8\n`);
				} else if (
					target_type.is_array &&
					(status.function_array_params?.has(name) || status.function_variadic_params?.has(name)) &&
					!is_local_ref_var(name, status)
				) {
					emit_asm(status, `ldr x0, [x0]\n`);
				} else if (
					target_is_simple &&
					!target_type.is_array &&
					(target_type.name !== "string" || has_stack_offset) &&
					!is_local_ref_var(name, status) &&
					// A `ref self` method receives &slot: keep the address
					// emit_var_address produced instead of loading the value.
					!method_self_is_ref
				) {
					const size = aarch64_size(target_type.name);
					const signed = is_signed_type(target_type.name);
					if (size === 1) {
						emit_asm(status, signed ? `ldrsb x0, [x0]\n` : `ldrb w0, [x0]\n`);
					} else if (size === 2) {
						emit_asm(status, signed ? `ldrsh x0, [x0]\n` : `ldrh w0, [x0]\n`);
					} else if (size === 4) {
						emit_asm(status, signed ? `ldrsw x0, [x0]\n` : `ldr w0, [x0]\n`);
					} else {
						emit_asm(status, `ldr x0, [x0]\n`);
					}
				}
			}
		} else if (!target_is_simple && node.target.node_type === "access") {
			const access_target = node.target as AccessNode;
			if (access_target.access.node_type === "access_field") {
				if (access_chain_crosses_class(access_target, status)) {
					// Nested chain through a class-typed field (`state.rules.blocks`)
					// — the summed-offset-from-root receiver address would skip the
					// pointer dereference. Build the target, which loads each
					// pointer hop: its result IS the receiver address.
					build_node(access_target, status);
					ensure_newline(status);
				} else {
					const offset = compute_field_offset(access_target, status);
					const base = get_base_target(access_target);
					if (base.node_type === "value") {
						const name = (base as ValueNode).value;
						const paramReg = get_param_reg(name, status);
						if (paramReg) {
							if (paramReg !== "x0") {
								emit_asm(status, `mov x0, ${paramReg}\n`);
							}
						} else if (is_local_ref_var(name, status)) {
							emit_deref_var_address(status, "x0", name);
						} else {
							emit_var_address(status, "x0", name);
						}
					} else {
						build_node(base, status);
						ensure_newline(status);
					}
					if (offset > 0) {
						emit_asm(status, `add x0, x0, #${offset}\n`);
					}
				}
				// A heap `Array<T>` field holds a POINTER to the heap buffer
				// (length at [0], data at [8]). The array methods expect the
				// DATA pointer, so dereference and skip the length prefix.
				if (target_type.is_array && target_type.is_array_heap) {
					emit_asm(status, `ldr x0, [x0]\n`);
					emit_asm(status, `add x0, x0, #8\n`);
				}
			} else {
				build_node(node.target, status);
				ensure_newline(status);
			}
		} else {
			build_node(node.target, status);
			ensure_newline(status);
			// A heap `Array<T>` value built by build_node (e.g. a field load
			// `obj.items` → the buffer BASE pointer, or a call result) must be
			// advanced to the DATA pointer the array methods expect (length at
			// [base], data at [base+8]).
			if (target_type.is_array && target_type.is_array_heap) {
				emit_asm(status, `add x0, x0, #8\n`);
			}
		}
	}

	// Trait dispatch with a non-value receiver re-evaluates the receiver in
	// the dispatch prologue (for the vtable lookup) AFTER argument
	// evaluation — clobbering the arg registers and double-running side
	// effects (`rules.pop().name()` both crashed and popped twice). Spill the
	// receiver to a dedicated slot here; the prologue restores from it
	// instead of rebuilding. (String-pair receivers use their own restore
	// path and are excluded.)
	const trait_target_for_recv = status.traits.find((t) => t.name === target_type.name);
	const will_trait_dispatch =
		!!trait_target_for_recv &&
		!!trait_target_for_recv.functions.find((f) => f.name === access_func.name);
	let trait_recv_slot: number | undefined;
	if (will_trait_dispatch && node.target.node_type !== "value" && !receiver_is_string) {
		trait_recv_slot = allocate_stack_space(status, 8, 8);
		emit_asm(status, `str x0, [x29, #${trait_recv_slot}]\n`);
	}

	// A chained spawn-class construction receiver (`Thread(fn(args)).start()`)
	// is a TEMPORARY instance — park the pointer so it can be freed once the
	// call has transferred its handles (ASYNC.md: the old
	// build_thread_start / build_thread_detach temp free, keyed on the
	// construction flags).
	const ctor_temp_node =
		node.target.node_type === "func_call"
			? (node.target as unknown as {
					is_thread_ctor?: boolean;
					is_fiber_ctor?: boolean;
					is_awaitable_ctor?: boolean;
				})
			: undefined;
	const ctor_temp_receiver = !!(
		ctor_temp_node &&
		(ctor_temp_node.is_thread_ctor ||
			ctor_temp_node.is_fiber_ctor ||
			ctor_temp_node.is_awaitable_ctor)
	);
	let ctor_recv_slot: number | undefined;
	if (ctor_temp_receiver && !access_func.is_static && !receiver_is_string) {
		ctor_recv_slot = allocate_stack_space(status, 8, 8);
		emit_asm(status, `str x0, [x29, #${ctor_recv_slot}]\n`);
	}

	const raw_needs_self =
		!access_func.is_static && access_func.params.length > 0 && !receiver_is_string;
	// Self-marshal elision (ASM_PLAN_2 tranche F): a raw-only inline
	// method whose body never reads self (no x19, x0 only as a
	// write-destination) needs neither the self spill, its restore, nor a
	// receiver in x0 — the args evaluate freely and the body's result
	// lands in x0 directly (BigInt mul_wide_hi/get_at/set_at/div128).
	const inline_struct0 = status.structs.find((s) => s.name === mono_struct_name);
	const inline_func0 = inline_struct0?.functions.find(
		(f) =>
			f.is_inline &&
			f.name === access_func.name &&
			(access_func.mangled_name
				? mangled_label(f, mono_struct_name) === access_func.mangled_name
				: true),
	);
	const elide_self_save =
		raw_needs_self && !!inline_func0 && naked_inline_skips_self(inline_func0, status.platform);
	const needs_self_save = raw_needs_self && !elide_self_save && !deferred_self_code;
	if (needs_self_save) {
		emit_asm(status, `str x0, [sp, #-16]!\n`);
	}

	// Evaluate params. For an instance method, x0 holds self (saved above)
	// and args go in x1..x7; for a static method args go in x0..x7. Args past
	// slot 7 arrive in the caller's outgoing stack area.
	// A `view T` param (view_param_indices) occupies TWO consecutive register
	// slots — the (ptr, len) pair — so an arg's slot is its declaration
	// position PLUS one per view param declared before it.
	// For an instance method, x0 holds self (restored after arg evaluation);
	// args start at slot 1. A fat-string receiver's pair occupies slots 0-1,
	// so args start at slot 2.
	const start_reg = access_func.is_static ? 0 : receiver_is_string ? 2 : 1;
	const view_arg_set = new Set(access_func.view_param_indices ?? []);
	// A fat `string` ARGUMENT consumes TWO consecutive slots — the (ptr,
	// len) pair — matching the callee prologue's pair spilling. Detection is
	// by the ARGUMENT's static type (a string-typed expression always rides
	// the pair ABI, even when the callee signature is still generic, e.g.
	// Map<string,int>'s `TK key`). `ref` args pass &slot — one pointer, not
	// a pair.
	const string_arg_set = new Set<number>();
	for (let i = 0; i < access_func.params.length; i++) {
		if ((access_func.ref_param_indices ?? []).includes(i)) continue;
		if (arg_is_string(access_func.params[i])) {
			string_arg_set.add(i);
		}
	}
	const arg_slot: number[] = [];
	let total_arg_slots = 0;
	for (let i = 0; i < access_func.params.length; i++) {
		arg_slot.push(total_arg_slots);
		total_arg_slots += view_arg_set.has(i) || string_arg_set.has(i) ? 2 : 1;
	}
	// Leaf-argument deferrability (tranche H): a scalar leaf whose
	// materialization is a single build_operand instruction can defer to the
	// post-evaluation stage. Call-free siblings gate named reads (a call in a
	// sibling argument could mutate an observable value through an inline
	// expansion — deferring the leaf's read past it would change semantics).
	const arg_call_free = access_func.params.map((p) => tree_is_call_free(p, status, new Set()));
	const arg_deferrable = (i: number): boolean => {
		if (start_reg + arg_slot[i] >= NUM_REG_ARGS) return false;
		const param = access_func.params[i];
		if (param.node_type !== "value") return false;
		const raw = (param as ValueNode).value;
		if (typeof raw !== "string" || raw === "null") return false;
		const const_leaf = is_int_literal(raw) || raw === "true" || raw === "false";
		if (!const_leaf && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return false;
		if (!const_leaf) {
			for (let j = 0; j < access_func.params.length; j++) {
				if (j !== i && !arg_call_free[j]) return false;
			}
		}
		return true;
	};
	const overflow_count = Math.max(0, total_arg_slots - (NUM_REG_ARGS - start_reg));
	let overflow_base = 0;
	if (overflow_count > 0) {
		overflow_base = allocate_stack_space(status, overflow_count * 8, 16);
	}
	// An INLINE capturing lambda argument to a func-typed (borrow) parameter
	// materializes a one-shot HEAP descriptor + env (CLOSURE.md) that the
	// callee never disposes — the call site owns them. The arg loop parks
	// each such descriptor in a dedicated frame slot; the slots are reclaimed
	// once the call has returned (after the outgoing-arg restore below).
	const lambda_arg_indices = new Set<number>();
	for (let i = 0; i < access_func.params.length; i++) {
		const p = access_func.params[i];
		if (p.node_type !== "func") continue;
		if (!(p as FunctionNode).captures?.length) continue;
		const cp = access_callee_params?.[i];
		if (!cp || !(cp.func_params || cp.func_return_type)) continue;
		lambda_arg_indices.add(i);
	}
	const lambda_arg_slots: number[] = [];
	// View and fat-string pairs are spilled to a dedicated area and reloaded
	// into their register pairs AFTER the loop — evaluating a later
	// (lower-index) argument can use x0-x2 as scratch, which would clobber a
	// pair claimed inline. A pair half whose register slot is past x7 goes to
	// the outgoing-area slot it occupies (copied down at the bl, like every
	// other overflow arg).
	const has_pair_args = view_arg_set.size > 0 || string_arg_set.size > 0;
	let view_spill_base = 0;
	if (has_pair_args) {
		view_spill_base = allocate_stack_space(status, total_arg_slots * 8, 16);
	}
	const view_half_store = (j: number, half: 0 | 1): number => {
		const half_slot = start_reg + arg_slot[j] + half;
		return half_slot >= NUM_REG_ARGS
			? overflow_base + (half_slot - NUM_REG_ARGS) * 8
			: view_spill_base + (arg_slot[j] + half) * 8;
	};
	// A STATIC method's first argument occupies x0 — the register every
	// deferred leaf's materialization parks its value through (func refs,
	// globals, ref scalars). Spill it in-loop and reload it after the
	// deferred materializations. A first argument that defers (a plain leaf
	// — `ref`/struct/enum args build in-loop before the deferral branch)
	// materializes last on its own, and pair args reload late, so neither
	// needs this.
	const param0 = access_func.params[0];
	const param0_is_pair = view_arg_set.has(0) || string_arg_set.has(0);
	const param0_is_ref = (access_func.ref_param_indices ?? []).includes(0);
	const param0_type_name = (param0 as any)?.type?.name || "";
	const param0_builds_in_loop =
		access_func.params.length > 0 &&
		(param0_is_ref ||
			is_struct_type(param0_type_name, status) ||
			is_enum_with_data_type(param0_type_name, status) ||
			!arg_deferrable(0));
	const static_arg0_needs_spill =
		start_reg === 0 && access_func.params.length > 0 && !param0_is_pair && param0_builds_in_loop;
	let static_arg0_spill = 0;
	if (static_arg0_needs_spill) {
		static_arg0_spill = allocate_stack_space(status, 8, 8);
	}
	// `ref` class PARAMS forwarded to a method's `ref` param: tracked so their
	// callee-saved registers can be reloaded from the caller's slot once the
	// call returns (the callee may have reassigned it).
	const ref_class_param_reload: string[] = [];
	// `ref` class LOCAL args passed by raw slot address: the callee may
	// reassign them (writing the new instance into the caller's slot), so the
	// scope-exit anchor slot is re-synced to the slot's current value after
	// the call.
	const ref_class_sync_names: string[] = [];
	for (let i = access_func.params.length - 1; i >= 0; i--) {
		const param = access_func.params[i];
		const is_ref_param = access_func.ref_param_indices?.includes(i);
		const param_type = (param as any).type?.name || "";
		// A `view string` argument: (ptr, len) pair in x0/x1 — a view VALUE
		// passes through, an owned string is wrapped with its strlen.
		if (view_arg_set.has(i)) {
			emit_view_string_arg(param, status);
			emit_asm(status, `str x0, [x29, #${view_half_store(i, 0)}]\n`);
			emit_asm(status, `str x1, [x29, #${view_half_store(i, 1)}]\n`);
			continue;
		}
		// A fat `string` argument is already the (ptr, len) pair in x0/x1 —
		// spill both halves like a view. A `null` literal (type rewritten to
		// the param's `string?` by the checker) zeroes BOTH halves: its build
		// leaves only x0 = 0, and x1 would carry garbage into the callee.
		if (string_arg_set.has(i)) {
			if (param.node_type === "value" && (param as ValueNode).value === "null") {
				emit_asm(status, `mov x0, #0\n`);
				emit_asm(status, `mov x1, #0\n`);
			} else {
				build_node(param, status);
				ensure_newline(status);
			}
			emit_asm(status, `str x0, [x29, #${view_half_store(i, 0)}]\n`);
			emit_asm(status, `str x1, [x29, #${view_half_store(i, 1)}]\n`);
			continue;
		}
		// Enum-with-data values (tag + payload, 16 bytes) use the same
		// pass-by-address convention as structs — mirrors the plain-function
		// call path in build_function_call_node.
		const is_struct =
			is_struct_type(param_type, status) || is_enum_with_data_type(param_type, status);
		if (is_ref_param) {
			const rp_name = param.node_type === "value" ? (param as ValueNode).value : undefined;
			const rp_slot = rp_name !== undefined ? status.ref_class_slots?.get(rp_name) : undefined;
			if (rp_slot !== undefined) {
				// Forwarding a `ref` class PARAM: its callee-saved register
				// holds the instance, but the callee dereferences its ref-param
				// argument at entry — pass the caller's slot address stored in
				// ref_class_slots instead (mirrors the plain-call path).
				emit_asm(status, `ldr x0, [x29, #${rp_slot}]\n`);
				ref_class_param_reload.push(rp_name!);
			} else {
				// A `ref` CLASS local arg must pass the ADDRESS of the caller's
				// slot (`T**`): the callee dereferences it once at entry and may
				// reassign through it. emit_address_of would deref the local
				// (class locals are is_local_ref_var) and hand the callee the
				// instance pointer (T*) — which the callee then treats as the
				// slot, corrupting memory through the vtable word. A `ref`
				// struct local keeps emit_address_of: its slot points at the
				// struct, so the deref IS the struct's address, which is what
				// the callee wants. (Mirrors the plain-call path; the anchor is
				// re-synced after the call.)
				const arg_name = rp_name;
				let arg_is_class = false;
				if (arg_name) {
					const tn = (param as any).type?.name ?? status.variable_types?.get(arg_name)?.name;
					arg_is_class = !!tn && !!status.structs.find((s) => s.name === tn && s.is_class);
				}
				if (arg_name !== undefined && is_local_ref_var(arg_name, status) && arg_is_class) {
					emit_var_address(status, "x0", arg_name);
					ref_class_sync_names.push(arg_name);
				} else {
					emit_address_of(param, status);
				}
			}
		} else if (is_struct) {
			if (param.node_type === "value") {
				const name = (param as ValueNode).value;
				const paramReg = status.function_param_regs?.get(name);
				if (paramReg) {
					if (paramReg !== "x0") {
						emit_asm(status, `mov x0, ${paramReg}\n`);
					}
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
			} else {
				build_node(param, status);
				ensure_newline(status);
			}
		} else if (arg_deferrable(i)) {
			deferred_args.push({ param, slot: arg_slot[i] });
			continue;
		} else {
			build_node(param, status);
			// A capturing lambda's one-shot descriptor: park it for post-call
			// reclamation (the callee only borrows it).
			if (lambda_arg_indices.has(i)) {
				const dispose_slot = allocate_stack_space(status, 8, 8);
				emit_asm(status, `str x0, [x29, #${dispose_slot}]\n`);
				lambda_arg_slots.push(dispose_slot);
			}
		}
		const slot = start_reg + arg_slot[i];
		ensure_newline(status);
		if (slot >= NUM_REG_ARGS) {
			// Overflow: spill to a local slot; copied to the outgoing area
			// once self has been restored to x0 below.
			emit_asm(status, `str x0, [x29, #${overflow_base + (slot - NUM_REG_ARGS) * 8}]\n`);
		} else {
			// The AAPCS register IS the slot index: static args start at x0,
			// instance args at x1 (self = slot 0), fat-string-receiver args
			// at x2 (the receiver pair owns slots 0-1).
			const reg = `x${slot}`;
			if (reg !== "x0") {
				emit_asm(status, `mov ${reg}, x0\n`);
			} else if (static_arg0_needs_spill) {
				emit_asm(status, `str x0, [x29, #${static_arg0_spill}]\n`);
			}
		}
	}
	// Deferred leaf arguments (tranche H): materialize directly into their
	// slot registers — every argument evaluation is complete, so nothing can
	// clobber them and no evaluation can be reordered past a side effect
	// (the call-free sibling gate decided that at the deferral site).
	// DESCENDING slot order: a leaf whose build_operand falls back to
	// build_node parks its value through x0 (func refs, globals, ref
	// scalars) — that may only clobber registers not yet parked, so x0
	// materializes last.
	deferred_args.sort((a, b) => b.slot - a.slot);
	for (const d of deferred_args) {
		build_operand(d.param, `x${start_reg + d.slot}`, status);
		ensure_newline(status);
	}
	// Reload the spilled view/string pairs into their register slots AFTER
	// the deferred materializations (a leaf parking through x0 would clobber
	// an earlier x0 pair half). Halves at register slots past x7 stay in the
	// outgoing-area slots.
	if (has_pair_args) {
		for (let j = 0; j < access_func.params.length; j++) {
			if (!view_arg_set.has(j) && !string_arg_set.has(j)) continue;
			for (const half of [0, 1] as const) {
				const half_slot = start_reg + arg_slot[j] + half;
				if (half_slot >= NUM_REG_ARGS) continue;
				emit_asm(
					status,
					`ldr x${half_slot}, [x29, #${view_spill_base + (arg_slot[j] + half) * 8}]\n`,
				);
			}
		}
	}
	// Restore the static first argument last of all: everything above (the
	// deferred materializations, the pair reloads) may pass through x0.
	if (static_arg0_needs_spill) {
		ensure_newline(status);
		emit_asm(status, `ldr x0, [x29, #${static_arg0_spill}]\n`);
	}

	ensure_newline(status);
	if (receiver_is_string) {
		// Restore the fat receiver's pair into x0/x1. When the call consumes
		// an OWNED receiver temp (frees_string_receiver), keep the pair's
		// stack frame so the ptr half can be freed after the call.
		emit_asm(status, frees_string_receiver ? `ldp x0, x1, [sp]\n` : `ldp x0, x1, [sp], #16\n`);
	} else if (deferred_self_code) {
		// The self value lived in a callee-saved register all along — load
		// it now (after argument evaluation) instead of push/pop round-trips.
		emit_asm(status, deferred_self_code);
	} else if (needs_self_save) {
		emit_asm(status, `ldr x0, [sp], #16\n`);
	}

	// AAPCS64: args past x0..x7 go in the caller's outgoing stack area at
	// [sp] at the moment of the bl/blr. Lower sp by the outgoing area size
	// and copy each overflow arg from its spill slot. Restored right after
	// the call.
	let outgoing_size = 0;
	if (overflow_count > 0) {
		outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
		emit_asm(status, `sub sp, sp, #${outgoing_size}\n`);
		for (let k = 0; k < overflow_count; k++) {
			emit_asm(status, `ldr x9, [x29, #${overflow_base + k * 8}]\n`);
			emit_asm(status, `str x9, [sp, #${k * 8}]\n`);
		}
	}

	const target_struct = status.structs.find((s) => s.name === mono_struct_name);
	const inline_func = target_struct?.functions.find(
		(f) =>
			(f.is_inline || is_auto_inline_method(f)) &&
			f.name === access_func.name &&
			(access_func.mangled_name
				? mangled_label(f, mono_struct_name) === access_func.mangled_name
				: true),
	);

	const trait_target = status.traits.find((t) => t.name === target_type.name);
	const trait_func = trait_target?.functions.find((f) => f.name === access_func.name);

	if (trait_target && trait_func) {
		// Trait-typed dispatch: resolve the concrete function via the vtable
		// (obj->_vt → [1 + trait_index] → [func_index]) and call it. Slot 0
		// of _<Struct>_traits is the destroy-funcs pointer (reserved so a
		// trait-typed collection can dispatch destroy polymorphically), so
		// real trait tables start at index 1. The lookup uses scratch
		// registers x9/x10 only, so the argument registers x0-x7 — set up
		// above (self for instance methods, the args themselves for
		// `static`/no-self trait methods) — survive untouched into the blr.
		// This handles trait methods whether or not they declare `self`: a
		// no-self method is flagged `is_static` (so the instance path skipped
		// self-loading and args start at x0), but it still must dispatch
		// through the vtable when the receiver is trait-typed.
		const trait_index = status.traits.indexOf(trait_target);
		const func_index = trait_target.functions.indexOf(trait_func);
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const paramReg = get_param_reg(name, status);
			if (paramReg) {
				emit_asm(status, `mov x9, ${paramReg}\n`);
			} else {
				emit_var_address(status, "x9", name);
				// A trait-typed class local stores a POINTER to the heap
				// instance (not the inline struct), so [&local] is the
				// instance pointer — dereference once so x9 holds the
				// instance whose vtable lives at offset 0, matching how a
				// trait param arrives (the pointer directly in its register).
				// The decision reads the name's scope-keyed binding: a
				// same-named sibling/shadowing local backed by inline value
				// struct storage records a null binding that blocks the
				// inherited one (dereferencing an inline struct's first field
				// as a vtable pointer corrupts the dispatch).
				if (trait_class_for(status, name) !== undefined) {
					emit_asm(status, `ldr x9, [x9]\n`);
					// The callee's self argument must likewise be the instance
					// pointer, not &local. The target build left x0 = &local;
					// overwrite it with the dereferenced instance so an
					// instance method that reads self fields dispatches
					// correctly. (Value-struct trait locals aren't tracked
					// here — for them &local IS the inline instance. Static /
					// no-self methods keep x0 as their first real argument.)
					if (!access_func.is_static) {
						emit_asm(status, `mov x0, x9\n`);
					}
				}
			}
		} else if (trait_recv_slot !== undefined) {
			emit_asm(status, `ldr x9, [x29, #${trait_recv_slot}]\n`);
		} else {
			build_node(node.target, status);
			ensure_newline(status);
			emit_asm(status, `mov x9, x0\n`);
		}
		emit_asm(status, `ldr x10, [x9]\n`);
		// +1 to skip the destroy slot at vtable[0].
		emit_asm(status, `ldr x10, [x10, #${(trait_index + 1) * 8}]\n`);
		emit_asm(status, `ldr x10, [x10, #${func_index * 8}]\n`);
		emit_asm(status, `blr x10\n`);
		// A float-returning trait method hands its result back in d0 —
		// bit-cast to x0 for the generic consumers.
		if (is_float_type(access_func.type.name)) {
			emit_asm(status, `fmov x0, d0\n`);
		}
		// An owned receiver (a `move out T` call like pop() spilled to the
		// trait_recv_slot above): the slot owns the instance, so destroy it
		// through the trait shim and free it now — mirroring the scope-exit
		// reclaim an owned trait-typed local gets. The dispatch result (x0,
		// plus x1 for fat string returns) is preserved across the calls.
		if (
			trait_recv_slot !== undefined &&
			node.target.node_type === "access" &&
			!!((node.target as AccessNode).access as AccessFunctionCallNode).owned_return
		) {
			emit_asm(status, `str x0, [sp, #-16]!\n`);
			emit_asm(status, `str x1, [sp, #-16]!\n`);
			emit_asm(status, `ldr x0, [x29, #${trait_recv_slot}]\n`);
			emit_asm(status, `bl ${trait_target.name}_destroy\n`);
			emit_asm(status, `ldr x0, [x29, #${trait_recv_slot}]\n`);
			emit_free(status);
			emit_asm(status, `ldr x1, [sp], #16\n`);
			emit_asm(status, `ldr x0, [sp], #16\n`);
		}
	} else if (
		inline_func &&
		overflow_count === 0 &&
		!receiver_is_string &&
		!inline_splice_active(mono_struct_name, access_func.name)
	) {
		// Inline candidates are small functions; the inline path can't accept
		// a pre-lowered outgoing-arg area, so skip inlining when this call
		// has overflow args and fall through to the regular bl. The splice-
		// active guard makes a nested call to the method currently being
		// spliced (recursion) take the bl instead of re-splicing forever.
		begin_inline_splice(mono_struct_name, access_func.name);
		build_inline_method(target_struct!, inline_func, status);
		end_inline_splice(mono_struct_name, access_func.name);
	} else {
		emit_asm(status, `bl ${method_name}\n`);
		// A float-returning method hands its result back in d0 (the d0
		// return convention) — bit-cast to x0 for the generic consumers.
		if (is_float_type(access_func.type.name)) {
			emit_asm(status, `fmov x0, d0\n`);
		}
	}

	// Free the outgoing stack-arg area now that the call has read it.
	if (outgoing_size > 0) {
		emit_asm(status, `add sp, sp, #${outgoing_size}\n`);
	}

	// Inline capturing lambda args were borrowed by the call — reclaim their
	// one-shot heap descriptors from the parked slots (x0/x1 preserved).
	emit_dispose_lambda_args_a64(status, lambda_arg_slots);

	// Free the temporary construction receiver now that the launch has
	// transferred its handles out of the instance (#destroy would no-op) —
	// preserving the call's result in x0 (/x1 for a fat pair).
	if (ctor_recv_slot !== undefined) {
		emit_asm(status, `str x0, [sp, #-16]!\n`);
		emit_asm(status, `str x1, [sp, #-16]!\n`);
		emit_asm(status, `ldr x0, [x29, #${ctor_recv_slot}]\n`);
		emit_free(status);
		emit_asm(status, `ldr x1, [sp], #16\n`);
		emit_asm(status, `ldr x0, [sp], #16\n`);
	}

	// The callee (string_to_string) copied the receiver's storage — free the
	// original temp now, preserving the result pair in x0/x1. Stack at this
	// point: [sp]=receiver.ptr, [sp+8]=receiver.len (kept by the non-popping
	// restore above).
	if (frees_string_receiver) {
		emit_asm(status, `ldr x9, [sp]\n`);
		emit_asm(status, `str x0, [sp, #-16]!\n`);
		emit_asm(status, `str x1, [sp, #-16]!\n`);
		emit_asm(status, `mov x0, x9\n`);
		emit_asm(status, `bl _nomen_free_wrap\n`);
		emit_asm(status, `ldr x1, [sp], #16\n`);
		emit_asm(status, `ldr x0, [sp], #16\n`);
		emit_asm(status, `add sp, sp, #16\n`);
	}

	// A `ref` class arg may have been reassigned by the callee, which wrote
	// the new pointer into the caller's slot. The caller's anchor slot (used
	// for cleanup at scope exit) still holds the old pointer — sync it to the
	// slot's current value so the new instance is freed once and the old one
	// (already freed by the callee) is not double-freed. If the callee did
	// not reassign, the slot is unchanged and this is a no-op. Preserve x0
	// across the sync — it holds the call's return value.
	if (ref_class_sync_names.some((n) => find_anchor_slot(status, n) !== undefined)) {
		emit_asm(status, `str x0, [sp, #-16]!\n`);
		for (const sync_name of ref_class_sync_names) {
			const anchor = find_anchor_slot(status, sync_name);
			if (anchor !== undefined) {
				emit_var_load(status, "x0", sync_name, 8);
				emit_asm(status, `str x0, [x29, #${anchor}]\n`);
			}
		}
		emit_asm(status, `ldr x0, [sp], #16\n`);
	}

	// A forwarded `ref` class PARAM may have been reassigned by the callee,
	// which wrote the new instance into the caller's slot. The param's
	// callee-saved register still holds the pre-call instance (possibly already
	// freed) — reload it from the slot so subsequent uses target the live
	// instance. x9 is caller-saved scratch; x0 (return value) is preserved.
	if (ref_class_param_reload.length > 0) {
		emit_asm(status, `str x0, [sp, #-16]!\n`);
		for (const reload_name of ref_class_param_reload) {
			const slot = status.ref_class_slots?.get(reload_name);
			const reg = status.function_param_regs?.get(reload_name);
			if (slot !== undefined && reg) {
				emit_asm(status, `ldr x9, [x29, #${slot}]\n`);
				emit_asm(status, `ldr ${reg}, [x9]\n`);
			}
		}
		emit_asm(status, `ldr x0, [sp], #16\n`);
	}

	if (access_func.move_param_indices?.length) {
		for (const idx of access_func.move_param_indices) {
			const param = access_func.params[idx];
			if (param?.node_type === "value") {
				// A `string` move arg keeps caller ownership (owning
				// Buffer<string> strdup's); skip mark_moved so scope-exit
				// cleanup frees it. Resolve the type from the declaration — a
				// bare variable reference's ValueNode.type is unset after mono —
				// searching every scope frame (the variable may live in an
				// outer scope when the call sits inside an if/loop branch).
				const vname = (param as { value?: string }).value;
				const decl = all_scope_frames(status)
					.flat()
					.find((d) => d.name === vname);
				const tname = decl?.type?.name ?? (param as { type?: { name?: string } }).type?.name;
				if (tname === "string") continue;
				// An enum-with-data `move` arg also keeps caller ownership: an
				// owning Buffer/List store_T deep-copies its string payloads,
				// so the caller's temp must still be reclaimed at scope exit.
				if (tname && status.enums.find((e) => e.name === tname && e.has_associated_data)) continue;
			}
			if (param) {
				mark_moved_if_struct(param, status);
			}
		}
	}

	// A value-struct method may overwrite the receiver's plain string fields
	// through `self` — writes the caller's heap_string_fields records can't
	// reflect (the method can't know the displaced values' ownership; see the
	// `tv !== "self"` gate in build_assignment_node's struct-string branch).
	// Drop the records for the fields the method writes so the receiver's
	// scope-exit cleanup never frees a value the method replaced with a
	// non-heap one. Conservative: a heap value the method wrote leaks instead
	// of being freed. Applies to both the bl and inline paths (an inlined
	// `self.field = …` keeps the `self` name and also bypasses the record).
	if (
		node.target.node_type === "value" &&
		target_struct &&
		!target_struct.is_class &&
		!trait_target
	) {
		const target_method = target_struct.functions.find((f) => f.name === access_func.name);
		if (target_method) {
			drop_self_written_string_field_records(
				status,
				(node.target as ValueNode).value,
				scan_self_string_field_writes(target_struct, target_method),
			);
		}
	}

	if (method_name.endsWith("_to_string") && method_name !== "string_to_string") {
		status.last_result_is_heap = true;
	}

	// Note: a dispatched trait method that returns a string hands back a
	// string-literal address (adr x0, _str_N), not a heap allocation — unlike
	// the C backend, which strdup's literals. So we deliberately do NOT set
	// last_result_is_heap here; the concrete-call path treats such returns the
	// same way (the literal lives in static data and is never freed).

	// ...unless EVERY known conformer's implementation returns owned heap:
	// then the dynamic result is owned regardless of which conformer runs,
	// and the caller must dup + free the original exactly like a concrete
	// owned-returning call (otherwise each such dispatch leaks). Mixed or
	// unknown conformers keep the borrow treatment — a leak beats freeing a
	// borrow. (The C backend sidesteps this: it normalizes every string
	// return to owned at the callee, so its unconditional dup + free is
	// always sound.)
	if (
		trait_target &&
		trait_func?.return_type?.name === "string" &&
		!trait_func.return_type?.is_view &&
		trait_method_all_conformers_owned(trait_target, access_func.name, status)
	) {
		status.last_result_is_heap = true;
	}

	if (status.heap_returning_functions?.has(method_name)) {
		if (process.env.NOMEN_DBG_HEAP) console.error(`DBG heap-returning hit: ${method_name}`);
		status.last_result_is_heap = true;
	}

	// A `Buffer<string>.move_T` (`move out T`) result is the slot's strdup'd
	// heap copy — the caller owns and must free it. move_T is inline raw asm,
	// so it isn't classified heap-returning via the return-node path, and the
	// monomorphized call's `owned_return`/type annotations are unset (a bare
	// variable receiver's type isn't substituted after mono). Detect it by the
	// mangled name (the only owning-string move primitive today).
	if (method_name === "Buffer_string_move") {
		status.last_result_is_heap = true;
	}

	// General `move out string` move-out accessors (Task<string>.result,
	// Channel.receive_string, List<string>.pop): the callee relinquishes an
	// owned heap buffer to the caller (the checker stamps owned_return), so
	// the receiving declaration must free it at scope exit. Generalizes the
	// Buffer_string_move name-match above to the annotation-driven form.
	if (
		access_func.owned_return &&
		access_func.type?.name === "string" &&
		!access_func.type.is_view
	) {
		status.last_result_is_heap = true;
	}

	if (return_struct) {
		emit_asm(status, `add x0, x29, #${temp_offset}\n`);
	}
}

function build_int_array_to_string(node: AccessNode, target_type: Type, status: BuildStatus) {
	const length = parseInt((target_type.length as ValueNode).value);
	const element_size = aarch64_size(target_type.name);

	// Get array base address into x19
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				emit_asm(status, `mov x0, ${paramReg}\n`);
			}
		} else if (status.heap_array_vars?.has(name)) {
			// Heap-allocated array: the variable holds a pointer to a malloc'd
			// buffer with an 8-byte length prefix, then the data. Dereference
			// and skip the prefix so x19 ends up at the first element (matching
			// the inline storage a stack array would have).
			emit_var_address(status, "x0", name);
			emit_asm(status, `ldr x0, [x0]\n`);
			emit_asm(status, `add x0, x0, #8\n`);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		ensure_newline(status);
	}

	// Save x19, x20
	emit_asm(status, `str x19, [sp, #-16]!\n`);
	emit_asm(status, `str x20, [sp, #-16]!\n`);
	emit_asm(status, `mov x19, x0\n`);

	// Allocate result buffer - estimate 20 bytes per int element
	const buf_size = Math.max(length * 20, 32);
	emit_asm(status, `mov x0, #${buf_size}\n`);
	emit_malloc(status);
	emit_asm(status, `mov x20, x0\n`);

	// Zero out the buffer
	emit_asm(status, `strb wzr, [x20]\n`);

	// Loop through elements
	for (let i = 0; i < length; i++) {
		// Load element
		const offset = i * element_size;
		if (element_size === 1) {
			emit_asm(status, `ldrb w0, [x19, #${offset}]\n`);
			emit_asm(status, `uxtb w0, w0\n`);
		} else {
			emit_asm(status, `ldr x0, [x19, #${offset}]\n`);
		}

		// Call int_to_string (or appropriate to_string)
		const to_string_fn = `${target_type.name}_to_string`;
		emit_asm(status, `bl ${to_string_fn}\n`);

		// Concatenate: strcat(x20, x0)
		emit_asm(status, `str x0, [sp, #-16]!\n`);
		emit_asm(status, `mov x1, x0\n`);
		emit_asm(status, `mov x0, x20\n`);
		emit_asm(status, `bl _strcat\n`);
		emit_asm(status, `ldr x0, [sp], #16\n`);
		emit_free(status);
	}

	// Return result in x0
	emit_asm(status, `mov x0, x20\n`);
	emit_asm(status, `ldr x20, [sp], #16\n`);
	emit_asm(status, `ldr x19, [sp], #16\n`);
}

function build_char_array_to_string(node: AccessNode, length: string, status: BuildStatus) {
	const len = parseInt(length);

	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				emit_asm(status, `mov x0, ${paramReg}\n`);
			}
		} else if (status.heap_array_vars?.has(name)) {
			// Heap-allocated array: the variable holds a pointer to a malloc'd
			// buffer with an 8-byte length prefix, then the data. Dereference
			// and skip the prefix so x19 ends up pointing at the first char
			// (matching the inline storage a stack array would have).
			emit_var_address(status, "x0", name);
			emit_asm(status, `ldr x0, [x0]\n`);
			emit_asm(status, `add x0, x0, #8\n`);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		ensure_newline(status);
	}

	emit_asm(status, `str x19, [sp, #-16]!\n`);
	emit_asm(status, `mov x19, x0\n`);
	emit_asm(status, `mov x0, #${len + 1}\n`);
	emit_malloc(status);

	for (let i = 0; i < len; i++) {
		emit_asm(status, `ldrb w1, [x19, #${i}]\n`);
		emit_asm(status, `strb w1, [x0, #${i}]\n`);
	}
	emit_asm(status, `strb wzr, [x0, #${len}]\n`);
	emit_asm(status, `ldr x19, [sp], #16\n`);
}

function resolve_access_type(node: AccessNode, status: BuildStatus): Type | null {
	const inner = node.access;

	if (inner.node_type === "access_func") {
		// Method-call result (e.g. `self.keys.load_T(k)`): resolve the
		// receiver's struct, find the method, and return its return type.
		// This lets `.hash()` dispatch correctly on a `load_T()` result
		// inside a monomorphized generic body (where the AccessFunctionCall
		// node's cached `.type` may carry the stale generic type param "T").
		const access_func = inner as AccessFunctionCallNode;
		let base_type: Type | null = null;
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const vtype = (node.target as ValueNode).type;
			if (vtype?.name) {
				base_type = vtype;
			} else if (name === "self" && status.current_struct) {
				base_type = new Type(status.current_struct.name);
			}
		} else if (node.target.node_type === "access") {
			base_type = resolve_access_type(node.target as AccessNode, status);
		}
		if (!base_type?.name) return null;
		const mono_name = mono_type_name(base_type);
		const struct =
			status.structs.find((s) => s.name === mono_name && !s.is_generic) ||
			status.structs.find((s) => s.name === base_type!.name);
		if (!struct) return null;
		const func = struct.functions.find(
			(f) => f.name === access_func.name || f.name === `#${access_func.name}`,
		);
		return func?.return_type || null;
	}

	if (inner.node_type !== "access_field") return null;
	const field_name = (inner as AccessFieldNode).name;

	let base_type: Type | null = null;
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const vtype = (node.target as ValueNode).type;
		if (vtype?.name) {
			base_type = vtype;
		} else if (name === "self" && status.current_struct) {
			base_type = new Type(status.current_struct.name);
		}
	} else if (node.target.node_type === "access") {
		base_type = resolve_access_type(node.target as AccessNode, status);
	}

	if (!base_type?.name) return null;
	const struct = status.structs.find((s) => s.name === base_type!.name);
	if (!struct) return null;
	const field = struct.fields.find((f) => f.name === field_name);
	return field?.type || null;
}
