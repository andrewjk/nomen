import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import {
	drop_self_written_string_field_records,
	scan_self_string_field_writes,
} from "../build_common/scan_self_string_writes.ts";
import built_in_types from "../built_in_types.ts";
import { mangled_label } from "../check/utils/function_overload.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_inline_method from "./build_inline_method.ts";
import build_node from "./build_node.ts";
import build_nursery_spawn from "./build_nursery_spawn.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free, emit_malloc } from "./utils/audit.ts";
import { all_scope_frames, mark_moved_if_struct } from "./utils/auto_destroy.ts";
import { NUM_REG_ARGS } from "./utils/stack_args.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	emit_var_load,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import { get_enum_size } from "./utils/struct_layout.ts";
import { get_field_offset, get_struct_size } from "./utils/struct_layout.ts";
import { emit_view_materialize_owned, emit_view_string_arg } from "./utils/view_value.ts";

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

// Emit strlen(target) leaving the length in x0. If the target expression
// produces an owned heap string temporary (e.g. Json.stringify(...) or an
// operator/interpolation result), free it after measuring so it does not leak.
// A bare variable registered in status.string_length_slots (a loop-invariant
// hoist from build_while_loop_node) loads the pre-computed length instead.
function emit_string_length(target: BaseNode, status: BuildStatus) {
	if (target.node_type === "value") {
		const slot = status.string_length_slots?.get((target as ValueNode).value);
		if (slot !== undefined) {
			status.last_result_is_heap = false;
			status.code += `ldr x0, [x29, #${slot}]\n`;
			return;
		}
	}
	status.last_result_is_heap = false;
	build_node(target, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	if (status.last_result_is_heap) {
		// x0 = owned heap string pointer. Save it, strlen, save length, free, restore.
		status.code += `str x0, [sp, #-16]!\n`;
		status.code += `bl _strlen\n`;
		status.code += `mov x1, x0\n`;
		status.code += `ldr x0, [sp], #16\n`;
		status.code += `str x1, [sp, #-16]!\n`;
		emit_free(status);
		status.code += `ldr x0, [sp], #16\n`;
	} else {
		status.code += `bl _strlen\n`;
	}
	status.last_result_is_heap = false;
}

/**
 * `view T` builtins, operating on the (ptr, len) slice stored in two stack
 * slots ([base]=ptr, [base+8]=len):
 *   v.at(i)        →  element at ptr[i], left in x0 (or a sret temp for a
 *                     struct element, with x0 = temp address)
 *   v.to_string()  →  malloc(len+1); memcpy; null-terminate; owned copy in x0
 *                     (string views only)
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
	if (!t?.is_view) return false;
	if (node.target.node_type !== "value") return false;
	const base = status.stack_offsets?.get((node.target as ValueNode).value);
	if (base === undefined) return false;

	const elem_name = t.name === "string" ? "char" : t.name;

	if (access_func.name === "at" && access_func.params.length === 1) {
		// index → x0, then x1=index, x0=ptr
		build_node(access_func.params[0], status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `mov x1, x0\n`;
		status.code += `ldr x0, [x29, #${base}]\n`;
		const elem_struct = status.structs.find((s) => s.name === elem_name && !s.is_simple_type);
		if (elem_struct) {
			// Struct element: addr = ptr + index*size; memcpy into a sret temp;
			// leave x0 = temp address (matches struct-returning method calls).
			const size = get_struct_size(elem_name, status);
			status.code += `mov x2, #${size}\n`;
			status.code += `madd x0, x1, x2, x0\n`; // x0 = ptr + index*size
			const temp_offset = allocate_stack_space(status, size);
			status.code += `mov x1, x0\n`; // x1 = elem addr (src)
			status.code += `add x0, x29, #${temp_offset}\n`; // x0 = temp (dst)
			status.code += `mov x2, #${size}\n`;
			status.code += `bl _memcpy\n`;
			status.code += `add x0, x29, #${temp_offset}\n`; // reload dst
			return true;
		}
		// Primitive element: scaled load based on element width.
		const size = aarch64_size(elem_name);
		const signed = elem_name.startsWith("int") || elem_name === "char";
		if (size === 1) {
			status.code += signed ? `ldrsb x0, [x0, x1]\n` : `ldrb w0, [x0, x1]\n`;
		} else if (size === 2) {
			status.code += signed ? `ldrsh x0, [x0, x1, lsl #1]\n` : `ldrh w0, [x0, x1, lsl #1]\n`;
		} else if (size === 4) {
			status.code += signed ? `ldrsw x0, [x0, x1, lsl #2]\n` : `ldr w0, [x0, x1, lsl #2]\n`;
		} else {
			status.code += `ldr x0, [x0, x1, lsl #3]\n`;
		}
		return true;
	}
	if (access_func.name === "to_string" && t.name === "string") {
		// Load ptr/len into x0/x1, then materialize an owned, len-bounded
		// copy (malloc(len+1); memcpy; null-terminate).
		status.code += `ldr x0, [x29, #${base}]\n`;
		status.code += `ldr x1, [x29, #${base + 8}]\n`;
		emit_view_materialize_owned(status);
		status.last_result_is_heap = true;
		return true;
	}
	return false;
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
						status.code += `mov x0, ${paramReg}\n`;
					}
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
			} else {
				emit_address_of(access.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}
			if (offset) {
				status.code += `add x0, x0, #${offset}\n`;
			}
		} else {
			build_node(node, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}
	} else {
		build_node(node, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
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
		built_in_types.includes(name) ||
		!!status.structs.find((s) => s.name === name) ||
		!!status.enums.find((e) => e.name === name) ||
		!!status.traits.find((t) => t.name === name)
	);
}

export function reset_access_temp_counter() {
	access_temp_counter = 0;
}

export default function build_access_node(node: AccessNode, status: BuildStatus) {
	switch (node.access.node_type) {
		case "access_field": {
			build_access_field(node, status);
			break;
		}
		case "access_func": {
			const access_func = node.access as AccessFunctionCallNode;
			// Escape hatch: `nursery.spawn(fn, args...)`. See ASYNC.md.
			if (access_func.is_nursery_spawn) {
				build_nursery_spawn(node, access_func, status);
				return;
			}
			// `view T` builtins (.at, .to_string) operate on the (ptr, len)
			// slice directly — emit inline and skip struct-method dispatch.
			if (build_view_op(node, access_func, status)) {
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
// call it from the loop preheader.
function emit_buffer_struct_addr(target: BaseNode, status: BuildStatus) {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			status.code += `mov x9, ${paramReg}\n`;
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
				status.code += `mov x9, ${bpReg}\n`;
			} else if (is_local_ref_var(bname, status)) {
				emit_deref_var_address(status, "x9", bname);
			} else {
				emit_var_address(status, "x9", bname);
			}
		} else {
			build_node(inner.target, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `mov x9, x0\n`;
		}
		if (foff > 0) {
			status.code += `add x9, x9, #${foff}\n`;
		}
	} else {
		build_node(target, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `mov x9, x0\n`;
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
	status.code += `ldr x9, [x9, #8]\n`;
	if (key && status.function_return_label) {
		const cache_reg = alloc_buffer_cache_reg(status);
		if (cache_reg) {
			status.code += `mov ${cache_reg}, x9\n`;
			if (!status.buffer_data_cache) status.buffer_data_cache = new Map();
			status.buffer_data_cache.set(key, cache_reg);
			if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
			status.callee_saved_regs_used.add(cache_reg);
			return cache_reg;
		}
	}
	return "x9";
}

function build_access_field(node: AccessNode, status: BuildStatus) {
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
				status.code += `mov x0, ${self_reg}\n`;
			}
			status.code += `ldr x0, [x0, #-8]\n`;
			return;
		}
	}

	if (access_field.type?.name === "func") {
		status.code += `adr x0, ${target_type.name}_${access_field.name}\n`;
		return;
	}

	const enum_node = status.enums.find((e) => e.name === (target_name || target_type?.name));
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === access_field.name);
		if (enum_case) {
			const case_index = enum_node.cases.indexOf(enum_case);
			if (enum_node.has_associated_data && enum_case.params.length === 0) {
				const enum_size = get_enum_size(target_name || target_type?.name || "", status);
				const temp_name = `_enum_${access_temp_counter++}`;
				const temp_offset = allocate_stack_space(status, enum_size);
				status.stack_offsets!.set(temp_name, temp_offset);
				status.code += `add x0, x29, #${temp_offset}\n`;
				status.code += `mov x1, #${case_index}\n`;
				status.code += `str x1, [x0]\n`;
				for (let off = 8; off < enum_size; off += 8) {
					status.code += `str xzr, [x0, #${off}]\n`;
				}
			} else {
				status.code += `mov x0, #${case_index}\n`;
			}
			return;
		}
	}

	// Check for enum payload field access (e.g., insect.count)
	const enum_with_data = status.enums.find(
		(e) => e.name === (target_name || target_type?.name) && e.has_associated_data,
	);
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
							status.code += `mov x0, ${paramReg}\n`;
						}
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x0", name);
					} else if (status.heap_array_vars?.has(name)) {
						emit_var_load(status, "x0", name, 8);
						status.code += `add x0, x0, #8\n`;
					} else {
						emit_var_address(status, "x0", name);
					}
				} else {
					build_node(node.target, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
				}
				const field_type = access_field.type?.name || "int";
				const field_size = aarch64_size(field_type);
				const signed =
					field_type.startsWith("int") ||
					field_type === "float" ||
					field_type === "float32" ||
					field_type === "float64";
				if (field_size === 1) {
					status.code += signed
						? `ldrsb x0, [x0, #${payload_offset}]\n`
						: `ldrb w0, [x0, #${payload_offset}]\n`;
				} else if (field_size === 4) {
					status.code += signed
						? `ldrsw x0, [x0, #${payload_offset}]\n`
						: `ldr w0, [x0, #${payload_offset}]\n`;
				} else {
					status.code += `ldr x0, [x0, #${payload_offset}]\n`;
				}
				return;
			}
		}
	}

	const bitset_node = status.bitsets.find((b) => b.name === target_type.name);
	if (bitset_node) {
		const case_index = bitset_node.cases.indexOf(access_field.name);
		if (case_index >= 0) {
			status.code += `mov x0, #(1 << ${case_index})\n`;
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
				status.code += `ldr x0, [x29, #${offset}]\n`;
			} else {
				status.code += `mov x0, #0\n`;
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
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `ldr x0, [x0]\n`;
			return;
		}
		// For stack arrays: load length from the 8-byte prefix at [base - 8]
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const offset = status.stack_offsets?.get(name);
			if (offset !== undefined) {
				// Array parameters store a pointer — dereference to get length from [ptr - 8]
				if (status.function_array_params?.has(name)) {
					status.code += `ldr x0, [x29, #${offset}]\n`;
					status.code += `ldr x0, [x0, #-8]\n`;
				} else {
					status.code += `ldr x0, [x29, #${offset - 8}]\n`;
				}
				return;
			}
			// Global array: length prefix is at label - 8
			status.code += `adr x0, ${name}\n`;
			status.code += `ldr x0, [x0, #-8]\n`;
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
						if (paramReg !== "x0") status.code += `mov x0, ${paramReg}\n`;
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x0", name);
					} else {
						emit_var_address(status, "x0", name);
					}
				} else {
					build_node(base, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
				}
				if (offset > 0) {
					status.code += `add x0, x0, #${offset}\n`;
				}
				status.code += `ldr x0, [x0]\n`;
				status.code += `ldr x0, [x0]\n`;
				return;
			}
		}
		status.code += `mov x0, #0\n`;
		return;
	}

	// view T.length → the slice's stored length (second word of the local).
	// Must precede the string.length case: a view string also has name "string".
	if (target_type.is_view && access_field.name === "length" && node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const offset = status.stack_offsets?.get(name);
		if (offset !== undefined) {
			status.code += `ldr x0, [x29, #${offset + 8}]\n`;
		} else {
			status.code += `mov x0, #0\n`;
		}
		return;
	}

	// String.length → strlen(self)
	if (target_type.name === "string" && access_field.name === "length") {
		emit_string_length(node.target, status);
		return;
	}

	const offset = compute_field_offset(node, status);
	const base = get_base_target(node);

	const target_is_class_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_field" &&
		!!status.structs.find(
			(s) =>
				s.name === ((node.target as AccessNode).access as AccessFieldNode).type?.name && s.is_class,
		);

	// When target is a method call (e.g., points.at(0).x), build the method call
	// which leaves the result in x0, then apply the field offset from x0
	const target_is_method_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_func";

	if (target_is_method_access) {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const final_offset = offset;
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
		}
		return;
	}

	if (target_is_class_access) {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const final_offset = get_field_offset(target_type?.name || "", access_field.name, status);
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
		}
		return;
	}

	const target_is_ref_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_field" &&
		((node.target as AccessNode).access as AccessFieldNode).type?.is_ref;

	if (target_is_ref_access) {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const final_offset = get_field_offset(access_field.type?.name || "", access_field.name, status);
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
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
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else {
			emit_var_load(status, "x0", name, 8);
		}
		const final_offset = get_field_offset(target_type?.name || "", access_field.name, status);
		// A STRUCT-typed field of a class instance is embedded inline; its
		// "value" is its address (instance + offset) — same convention as the
		// generic field_is_struct path below. Loading a word here would hand
		// consumers the field's first scalar (e.g. Span.index) as a pointer.
		const field_type_obj = resolve_field_type(access_field, target_type?.name, status);
		const resolved_field_type = field_type_obj?.name || "";
		const field_is_struct =
			!!resolved_field_type &&
			!field_type_obj?.is_ref &&
			!field_type_obj?.is_nullable &&
			is_struct_type(resolved_field_type, status);
		if (field_is_struct) {
			if (final_offset > 0) {
				status.code += `add x0, x0, #${final_offset}\n`;
			}
			return;
		}
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
		}
		return;
	}

	// Get base address into x0
	if (base.node_type === "value") {
		const name = (base as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x0", name);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(base, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	const field_type_obj = resolve_field_type(access_field, target_type?.name, status);
	const resolved_field_type = field_type_obj?.name || "";
	const field_is_struct =
		!!resolved_field_type &&
		!field_type_obj?.is_ref &&
		!field_type_obj?.is_nullable &&
		is_struct_type(resolved_field_type, status);

	if (field_is_struct) {
		if (offset > 0) {
			status.code += `add x0, x0, #${offset}\n`;
		}
		return;
	}

	const size = aarch64_size(resolved_field_type);
	const signed =
		resolved_field_type.startsWith("int") ||
		resolved_field_type === "float" ||
		resolved_field_type === "float32" ||
		resolved_field_type === "float64";
	if (size === 1) {
		status.code += signed ? `ldrsb x0, [x0, #${offset}]\n` : `ldrb w0, [x0, #${offset}]\n`;
	} else if (size === 4) {
		status.code += signed ? `ldrsw x0, [x0, #${offset}]\n` : `ldr w0, [x0, #${offset}]\n`;
	} else {
		status.code += `ldr x0, [x0, #${offset}]\n`;
	}
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
	const enum_node = status.enums.find((e) => e.name === target_name);
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === access_func.name);
		if (enum_case) {
			const case_index = enum_node.cases.indexOf(enum_case);
			if (enum_node.has_associated_data) {
				const enum_size = get_enum_size(target_name!, status);
				const temp_name = `_enum_${access_temp_counter++}`;
				const temp_offset = allocate_stack_space(status, enum_size);
				status.stack_offsets!.set(temp_name, temp_offset);
				status.code += `add x0, x29, #${temp_offset}\n`;
				status.code += `mov x1, #${case_index}\n`;
				status.code += `str x1, [x0]\n`;
				let payload_offset = 8;
				for (let i = access_func.params.length - 1; i >= 0; i--) {
					build_node(access_func.params[i], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					const param_size = aarch64_size(enum_case.params[i].type.name);
					const abs_offset = temp_offset + payload_offset;
					if (param_size === 1) {
						status.code += `strb w0, [x29, #${abs_offset}]\n`;
					} else if (param_size === 4) {
						status.code += `str w0, [x29, #${abs_offset}]\n`;
					} else {
						status.code += `str x0, [x29, #${abs_offset}]\n`;
					}
					payload_offset += param_size;
				}
				status.code += `add x0, x29, #${temp_offset}\n`;
			} else {
				status.code += `mov x0, #${case_index}\n`;
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
					status.code += `mov x0, ${paramReg}\n`;
				}
			} else {
				emit_var_address(status, "x0", name);
			}
			status.code += `ldr x0, [x0]\n`;
		} else {
			build_node(node.target, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}
		status.code += `bl int_to_string\n`;
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
				!elem_struct &&
				elem_type_name.startsWith("int") &&
				elem_type_name !== "int8" &&
				elem_type_name !== "int16" &&
				elem_type_name !== "int32";

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

			if (set_fast) {
				// .set() fast path: base → x9, index → x1, value → x2, store.
				// Base is built first so a param-register base (e.g. an array
				// passed in x1) is read before x1 is overwritten by the index.
				const name = (node.target as ValueNode).value;
				const paramReg = get_param_reg(name, status);
				if (paramReg) {
					status.code += `mov x9, ${paramReg}\n`;
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x9", name);
				} else if (status.heap_array_vars?.has(name)) {
					emit_var_address(status, "x9", name);
					status.code += `ldr x9, [x9]\n`;
					status.code += `add x9, x9, #8\n`;
				} else if (
					status.function_array_params?.has(name) ||
					status.function_variadic_params?.has(name)
				) {
					emit_var_address(status, "x9", name);
					status.code += `ldr x9, [x9]\n`;
				} else {
					emit_var_address(status, "x9", name);
				}
				// index → x1
				build_node(access_func.params[0], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `mov x1, x0\n`;
				// value → x2 (simple value node: build only writes x0)
				build_node(access_func.params[1], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `mov x2, x0\n`;
				// store
				if (elem_size === 8) {
					status.code += `str x2, [x9, x1, lsl #3]\n`;
				} else {
					status.code += `mov x3, #${elem_size}\n`;
					status.code += `mul x1, x1, x3\n`;
					if (elem_size === 1) {
						status.code += `strb w2, [x9, x1]\n`;
					} else if (elem_size === 2) {
						status.code += `strh w2, [x9, x1]\n`;
					} else if (elem_size === 4) {
						status.code += `str w2, [x9, x1]\n`;
					} else {
						status.code += `str x2, [x9, x1]\n`;
					}
				}
				return;
			}

			if (use_fast_path) {
				// .at(): evaluate index → x1, compute base → x9, load
				if (access_func.params.length > 0) {
					build_node(access_func.params[0], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x1, x0\n`;
				}
				// Build target (array base) into x9
				if (node.target.node_type === "value") {
					const name = (node.target as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						status.code += `mov x9, ${paramReg}\n`;
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x9", name);
					} else if (status.heap_array_vars?.has(name)) {
						emit_var_address(status, "x9", name);
						status.code += `ldr x9, [x9]\n`;
						status.code += `add x9, x9, #8\n`;
					} else if (
						status.function_array_params?.has(name) ||
						status.function_variadic_params?.has(name)
					) {
						emit_var_address(status, "x9", name);
						status.code += `ldr x9, [x9]\n`;
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
							status.code += `mov x9, ${bpReg}\n`;
						} else if (is_local_ref_var(base_name, status)) {
							emit_deref_var_address(status, "x9", base_name);
						} else {
							emit_var_address(status, "x9", base_name);
						}
					} else {
						build_node(inner_base, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						status.code += `mov x9, x0\n`;
					}
					if (field_offset > 0) {
						status.code += `add x9, x9, #${field_offset}\n`;
					}
				}
				// Load element
				if (elem_struct) {
					if (elem_size === 8) {
						status.code += `add x0, x9, x1, lsl #3\n`;
					} else {
						status.code += `mov x2, #${elem_size}\n`;
						status.code += `mul x1, x1, x2\n`;
						status.code += `add x0, x9, x1\n`;
					}
				} else {
					if (elem_size === 8) {
						status.code += `ldr x0, [x9, x1, lsl #3]\n`;
					} else {
						status.code += `mov x2, #${elem_size}\n`;
						status.code += `mul x1, x1, x2\n`;
						if (elem_size === 1) {
							status.code += elem_signed ? `ldrsb x0, [x9, x1]\n` : `ldrb w0, [x9, x1]\n`;
						} else if (elem_size === 2) {
							status.code += elem_signed ? `ldrsh x0, [x9, x1]\n` : `ldrh w0, [x9, x1]\n`;
						} else if (elem_size === 4) {
							status.code += elem_signed ? `ldrsw x0, [x9, x1]\n` : `ldr w0, [x9, x1]\n`;
						} else {
							status.code += `ldr x0, [x9, x1]\n`;
						}
					}
				}
				return;
			}

			// .set(): still uses x19 save/restore (both index and value params)
			status.code += `str x19, [sp, #-16]!\n`;

			// Build target (array pointer) into x19
			if (node.target.node_type === "value") {
				const name = (node.target as ValueNode).value;
				const paramReg = get_param_reg(name, status);
				if (paramReg) {
					status.code += `mov x19, ${paramReg}\n`;
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x19", name);
				} else if (status.heap_array_vars?.has(name)) {
					// Heap-allocated array: variable stores a heap pointer with an 8-byte
					// length prefix. Dereference and skip the prefix to get the first element.
					emit_var_address(status, "x19", name);
					status.code += `ldr x19, [x19]\n`;
					status.code += `add x19, x19, #8\n`;
				} else if (
					status.function_array_params?.has(name) ||
					status.function_variadic_params?.has(name)
				) {
					// Array passed as a param: variable stores a pointer to raw data (no prefix)
					emit_var_address(status, "x19", name);
					status.code += `ldr x19, [x19]\n`;
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
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x19, x0\n`;
				}
				if (field_offset > 0) {
					status.code += `add x19, x19, #${field_offset}\n`;
				}
			}
			// Build index argument into x1
			if (access_func.params.length > 0) {
				build_node(access_func.params[0], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `mov x1, x0\n`;
			}

			if (access_func.name === "at") {
				if (elem_struct) {
					// Struct element: compute address (base + index * elem_size), return pointer
					if (elem_size === 8) {
						status.code += `add x0, x19, x1, lsl #3\n`;
					} else {
						status.code += `mov x2, #${elem_size}\n`;
						status.code += `mul x1, x1, x2\n`;
						status.code += `add x0, x19, x1\n`;
					}
				} else {
					// Simple element: compute offset and load value
					if (elem_size === 8) {
						status.code += `ldr x0, [x19, x1, lsl #3]\n`;
					} else {
						status.code += `mov x2, #${elem_size}\n`;
						status.code += `mul x1, x1, x2\n`;
						if (elem_size === 1) {
							status.code += elem_signed ? `ldrsb x0, [x19, x1]\n` : `ldrb w0, [x19, x1]\n`;
						} else if (elem_size === 2) {
							status.code += elem_signed ? `ldrsh x0, [x19, x1]\n` : `ldrh w0, [x19, x1]\n`;
						} else if (elem_size === 4) {
							status.code += elem_signed ? `ldrsw x0, [x19, x1]\n` : `ldr w0, [x19, x1]\n`;
						} else {
							status.code += `ldr x0, [x19, x1]\n`;
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
							status.code += `mov x2, ${vReg}\n`;
						} else if (is_local_ref_var(vname, status)) {
							emit_deref_var_address(status, "x2", vname);
						} else {
							emit_var_address(status, "x2", vname);
						}
					} else {
						build_node(value_param, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						status.code += `mov x2, x0\n`;
					}
				}
				if (elem_struct) {
					// Struct element: x2 is address of value, memcpy to computed address
					if (elem_size === 8) {
						status.code += `add x0, x19, x1, lsl #3\n`;
					} else {
						status.code += `mov x3, #${elem_size}\n`;
						status.code += `mul x1, x1, x3\n`;
						status.code += `add x0, x19, x1\n`;
					}
					status.code += `mov x1, x2\n`;
					status.code += `mov x2, #${elem_size}\n`;
					status.code += `bl _memcpy\n`;
				} else {
					if (elem_size === 8) {
						status.code += `str x2, [x19, x1, lsl #3]\n`;
					} else {
						status.code += `mov x3, #${elem_size}\n`;
						status.code += `mul x1, x1, x3\n`;
						if (elem_size === 1) {
							status.code += `strb w2, [x19, x1]\n`;
						} else if (elem_size === 2) {
							status.code += `strh w2, [x19, x1]\n`;
						} else if (elem_size === 4) {
							status.code += `str w2, [x19, x1]\n`;
						} else {
							status.code += `str x2, [x19, x1]\n`;
						}
					}
				}
			}
			status.code += `ldr x19, [sp], #16\n`;
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
			"grow",
			"grow_T",
			"grow_float",
			"alloc_int",
			"alloc",
			"alloc_T",
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

		const buffer_load_methods = new Set(["load_int", "load", "load_float"]);
		const buffer_store_methods = new Set(["store_int", "store", "store_float", "store_or_int"]);
		const is_buf_load = buffer_load_methods.has(method);
		const is_buf_store = buffer_store_methods.has(method);

		if (is_buf_load || is_buf_store) {
			// Element size: load/store = 4 bytes (uint32), load_int/store_int/
			// load_float/store_float/store_or_int = 8 bytes (long/double).
			// store_or_int treats data as long* (8-byte stride, see Buffer.nm).
			const elem_bytes = method === "load" || method === "store" ? 4 : 8;
			const shift = elem_bytes === 8 ? 3 : 2;
			const is_float = method === "load_float" || method === "store_float";

			if (is_buf_load) {
				// Evaluate index → x1
				if (access_func.params.length > 0) {
					build_node(access_func.params[0], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x1, x0\n`;
				}
				// Get data pointer (cached or freshly loaded)
				const data_reg = get_buffer_data_ptr(node.target, status);
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
					status.code += `ldr d0, [${data_reg}, x1, lsl #${shift}]\n`;
					if (!caller_wants_d0) {
						status.code += `fmov x0, d0\n`;
					}
				} else if (elem_bytes === 8) {
					status.code += `ldr x0, [${data_reg}, x1, lsl #3]\n`;
				} else {
					status.code += `ldr w0, [${data_reg}, x1, lsl #2]\n`;
				}
			} else {
				// Store: evaluate index (push), value (→x2), pop index (→x1)
				build_node(access_func.params[0], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `str x0, [sp, #-16]!\n`;
				build_node(access_func.params[1], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `mov x2, x0\n`;
				status.code += `ldr x1, [sp], #16\n`;
				// Get data pointer (cached or freshly loaded)
				const data_reg = get_buffer_data_ptr(node.target, status);
				// Strided store
				if (method === "store_or_int") {
					if (elem_bytes === 8) {
						status.code += `ldr x0, [${data_reg}, x1, lsl #3]\n`;
						status.code += `orr x2, x0, x2\n`;
						status.code += `str x2, [${data_reg}, x1, lsl #3]\n`;
					} else {
						status.code += `ldr w0, [${data_reg}, x1, lsl #2]\n`;
						status.code += `orr w2, w0, w2\n`;
						status.code += `str w2, [${data_reg}, x1, lsl #2]\n`;
					}
				} else if (is_float) {
					// The value was built via build_node and moved to x2 as a raw
					// 64-bit bit pattern (the default convention). Store from x2 —
					// NOT d0, which holds whatever stale float a prior op left
					// behind. (Pre-existing latent bug masked by d0 usually
					// happening to still hold the right value.)
					status.code += `str x2, [${data_reg}, x1, lsl #${shift}]\n`;
				} else if (elem_bytes === 8) {
					status.code += `str x2, [${data_reg}, x1, lsl #3]\n`;
				} else {
					status.code += `str w2, [${data_reg}, x1, lsl #2]\n`;
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

	// Check if method returns a struct. A `view T` return is a (ptr, len) pair
	// in x0/x1, not a sret struct — exclude views even when T is a struct.
	// An ARRAY-typed return (`out Array<T>`, e.g. `with`/`add`/`mul`) is a
	// heap buffer POINTER in x0, never an sret struct — even when the element
	// T is itself a struct (the element name would otherwise match below).
	const return_struct =
		!access_func.type.is_view &&
		!access_func.type.is_array &&
		!!status.structs.find(
			(s) => s.name === access_func.type.name && !s.is_simple_type && !s.is_class,
		);

	let temp_addr = "";
	let temp_offset = 0;
	if (return_struct) {
		temp_addr = `_access_temp_${access_temp_counter++}`;
		temp_offset = allocate_stack_space(status, get_struct_size(access_func.type.name, status));
		status.stack_offsets!.set(temp_addr, temp_offset);
		status.code += `add x8, x29, #${temp_offset}\n`;
	}

	if (!access_func.is_static) {
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
				if (paramReg !== "x0") {
					status.code += `mov x0, ${paramReg}\n`;
				}
			} else if (is_literal_value || (name.startsWith("'") && name.endsWith("'"))) {
				build_node(node.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
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
					status.code += `ldr x0, [x0]\n`;
					status.code += `add x0, x0, #8\n`;
				} else if (
					target_type.is_array &&
					(status.function_array_params?.has(name) || status.function_variadic_params?.has(name)) &&
					!is_local_ref_var(name, status)
				) {
					status.code += `ldr x0, [x0]\n`;
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
					const signed =
						target_type.name.startsWith("int") ||
						target_type.name === "float" ||
						target_type.name === "float32" ||
						target_type.name === "float64";
					if (size === 1) {
						status.code += signed ? `ldrsb x0, [x0]\n` : `ldrb w0, [x0]\n`;
					} else if (size === 4) {
						status.code += signed ? `ldrsw x0, [x0]\n` : `ldr w0, [x0]\n`;
					} else {
						status.code += `ldr x0, [x0]\n`;
					}
				}
			}
		} else if (!target_is_simple && node.target.node_type === "access") {
			const access_target = node.target as AccessNode;
			if (access_target.access.node_type === "access_field") {
				const offset = compute_field_offset(access_target, status);
				const base = get_base_target(access_target);
				if (base.node_type === "value") {
					const name = (base as ValueNode).value;
					const paramReg = get_param_reg(name, status);
					if (paramReg) {
						if (paramReg !== "x0") {
							status.code += `mov x0, ${paramReg}\n`;
						}
					} else if (is_local_ref_var(name, status)) {
						emit_deref_var_address(status, "x0", name);
					} else {
						emit_var_address(status, "x0", name);
					}
				} else {
					build_node(base, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
				}
				if (offset > 0) {
					status.code += `add x0, x0, #${offset}\n`;
				}
				// A heap `Array<T>` field holds a POINTER to the heap buffer
				// (length at [0], data at [8]). The array methods expect the
				// DATA pointer, so dereference and skip the length prefix.
				if (target_type.is_array && target_type.is_array_heap) {
					status.code += `ldr x0, [x0]\n`;
					status.code += `add x0, x0, #8\n`;
				}
			} else {
				build_node(node.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}
		} else {
			build_node(node.target, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			// A heap `Array<T>` value built by build_node (e.g. a field load
			// `obj.items` → the buffer BASE pointer, or a call result) must be
			// advanced to the DATA pointer the array methods expect (length at
			// [base], data at [base+8]).
			if (target_type.is_array && target_type.is_array_heap) {
				status.code += `add x0, x0, #8\n`;
			}
		}
	}

	const needs_self_save = !access_func.is_static && access_func.params.length > 0;
	if (needs_self_save) {
		status.code += `str x0, [sp, #-16]!\n`;
	}

	// Evaluate params. For an instance method, x0 holds self (saved above)
	// and args go in x1..x7; for a static method args go in x0..x7. Args past
	// slot 7 arrive in the caller's outgoing stack area.
	// A `view T` param (view_param_indices) occupies TWO consecutive register
	// slots — the (ptr, len) pair — so an arg's slot is its declaration
	// position PLUS one per view param declared before it.
	const start_reg = access_func.is_static ? 0 : 1;
	const param_regs = access_func.is_static
		? ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"]
		: ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const view_arg_set = new Set(access_func.view_param_indices ?? []);
	const arg_slot: number[] = [];
	let total_arg_slots = 0;
	for (let i = 0; i < access_func.params.length; i++) {
		arg_slot.push(total_arg_slots);
		total_arg_slots += view_arg_set.has(i) ? 2 : 1;
	}
	const overflow_count = Math.max(0, total_arg_slots - (NUM_REG_ARGS - start_reg));
	let overflow_base = 0;
	if (overflow_count > 0) {
		overflow_base = allocate_stack_space(status, overflow_count * 8, 16);
	}
	// View pairs are spilled to a dedicated area and reloaded into their
	// register pair AFTER the loop — evaluating a later (lower-index)
	// argument can use x0-x2 as scratch, which would clobber a pair claimed
	// inline. A pair half whose register slot is past x7 goes to the
	// outgoing-area slot it occupies (copied down at the bl, like every
	// other overflow arg).
	const has_view_args = view_arg_set.size > 0;
	let view_spill_base = 0;
	if (has_view_args) {
		view_spill_base = allocate_stack_space(status, total_arg_slots * 8, 16);
	}
	const view_half_store = (j: number, half: 0 | 1): number => {
		const half_slot = start_reg + arg_slot[j] + half;
		return half_slot >= NUM_REG_ARGS
			? overflow_base + (half_slot - NUM_REG_ARGS) * 8
			: view_spill_base + (arg_slot[j] + half) * 8;
	};
	// `ref` class PARAMS forwarded to a method's `ref` param: tracked so their
	// callee-saved registers can be reloaded from the caller's slot once the
	// call returns (the callee may have reassigned it).
	const ref_class_param_reload: string[] = [];
	for (let i = access_func.params.length - 1; i >= 0; i--) {
		const param = access_func.params[i];
		const is_ref_param = access_func.ref_param_indices?.includes(i);
		const param_type = (param as any).type?.name || "";
		// A `view string` argument: (ptr, len) pair in x0/x1 — a view VALUE
		// passes through, an owned string is wrapped with its strlen.
		if (view_arg_set.has(i)) {
			emit_view_string_arg(param, status);
			status.code += `str x0, [x29, #${view_half_store(i, 0)}]\n`;
			status.code += `str x1, [x29, #${view_half_store(i, 1)}]\n`;
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
				status.code += `ldr x0, [x29, #${rp_slot}]\n`;
				ref_class_param_reload.push(rp_name!);
			} else {
				emit_address_of(param, status);
			}
		} else if (is_struct) {
			if (param.node_type === "value") {
				const name = (param as ValueNode).value;
				const paramReg = status.function_param_regs?.get(name);
				if (paramReg) {
					if (paramReg !== "x0") {
						status.code += `mov x0, ${paramReg}\n`;
					}
				} else if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
			} else {
				build_node(param, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}
		} else {
			build_node(param, status);
		}
		const slot = start_reg + arg_slot[i];
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		if (slot >= NUM_REG_ARGS) {
			// Overflow: spill to a local slot; copied to the outgoing area
			// once self has been restored to x0 below.
			status.code += `str x0, [x29, #${overflow_base + (slot - NUM_REG_ARGS) * 8}]\n`;
		} else {
			const reg = param_regs[arg_slot[i]];
			if (reg && reg !== "x0") {
				status.code += `mov ${reg}, x0\n`;
			}
		}
	}
	// Reload the spilled view pairs into their register slots now that every
	// argument has been evaluated (no later evaluation can clobber them).
	// Halves at register slots past x7 stay in the outgoing-area slots.
	if (has_view_args) {
		for (let j = 0; j < access_func.params.length; j++) {
			if (!view_arg_set.has(j)) continue;
			for (const half of [0, 1] as const) {
				const half_slot = start_reg + arg_slot[j] + half;
				if (half_slot >= NUM_REG_ARGS) continue;
				status.code += `ldr x${half_slot}, [x29, #${view_spill_base + (arg_slot[j] + half) * 8}]\n`;
			}
		}
	}

	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	if (needs_self_save) {
		status.code += `ldr x0, [sp], #16\n`;
	}

	// AAPCS64: args past x0..x7 go in the caller's outgoing stack area at
	// [sp] at the moment of the bl/blr. Lower sp by the outgoing area size
	// and copy each overflow arg from its spill slot. Restored right after
	// the call.
	let outgoing_size = 0;
	if (overflow_count > 0) {
		outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
		status.code += `sub sp, sp, #${outgoing_size}\n`;
		for (let k = 0; k < overflow_count; k++) {
			status.code += `ldr x9, [x29, #${overflow_base + k * 8}]\n`;
			status.code += `str x9, [sp, #${k * 8}]\n`;
		}
	}

	const target_struct = status.structs.find((s) => s.name === mono_struct_name);
	const inline_func = target_struct?.functions.find(
		(f) =>
			f.is_inline &&
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
				status.code += `mov x9, ${paramReg}\n`;
			} else {
				emit_var_address(status, "x9", name);
				// A trait-typed class local stores a POINTER to the heap
				// instance (not the inline struct), so [&local] is the
				// instance pointer — dereference once so x9 holds the
				// instance whose vtable lives at offset 0, matching how a
				// trait param arrives (the pointer directly in its register).
				if (status.trait_class_locals?.has(name)) {
					status.code += `ldr x9, [x9]\n`;
					// The callee's self argument must likewise be the instance
					// pointer, not &local. The target build left x0 = &local;
					// overwrite it with the dereferenced instance so an
					// instance method that reads self fields dispatches
					// correctly. (Value-struct trait locals aren't tracked
					// here — for them &local IS the inline instance. Static /
					// no-self methods keep x0 as their first real argument.)
					if (!access_func.is_static) {
						status.code += `mov x0, x9\n`;
					}
				}
			}
		} else {
			build_node(node.target, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `mov x9, x0\n`;
		}
		status.code += `ldr x10, [x9]\n`;
		// +1 to skip the destroy slot at vtable[0].
		status.code += `ldr x10, [x10, #${(trait_index + 1) * 8}]\n`;
		status.code += `ldr x10, [x10, #${func_index * 8}]\n`;
		status.code += `blr x10\n`;
	} else if (inline_func && overflow_count === 0) {
		// Inline candidates are small functions; the inline path can't accept
		// a pre-lowered outgoing-arg area, so skip inlining when this call
		// has overflow args and fall through to the regular bl.
		build_inline_method(target_struct!, inline_func, status);
	} else {
		status.code += `bl ${method_name}\n`;
	}

	// Free the outgoing stack-arg area now that the call has read it.
	if (outgoing_size > 0) {
		status.code += `add sp, sp, #${outgoing_size}\n`;
	}

	// A forwarded `ref` class PARAM may have been reassigned by the callee,
	// which wrote the new instance into the caller's slot. The param's
	// callee-saved register still holds the pre-call instance (possibly already
	// freed) — reload it from the slot so subsequent uses target the live
	// instance. x9 is caller-saved scratch; x0 (return value) is preserved.
	if (ref_class_param_reload.length > 0) {
		status.code += `str x0, [sp, #-16]!\n`;
		for (const reload_name of ref_class_param_reload) {
			const slot = status.ref_class_slots?.get(reload_name);
			const reg = status.function_param_regs?.get(reload_name);
			if (slot !== undefined && reg) {
				status.code += `ldr x9, [x29, #${slot}]\n`;
				status.code += `ldr ${reg}, [x9]\n`;
			}
		}
		status.code += `ldr x0, [sp], #16\n`;
	}

	if (access_func.mov_param_indices?.length) {
		for (const idx of access_func.mov_param_indices) {
			const param = access_func.params[idx];
			if (param?.node_type === "value") {
				// A `string` mov arg keeps caller ownership (owning
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

	if (status.heap_returning_functions?.has(method_name)) {
		status.last_result_is_heap = true;
	}

	// A `Buffer<string>.move_T` (`mov out T`) result is the slot's strdup'd
	// heap copy — the caller owns and must free it. move_T is inline raw asm,
	// so it isn't classified heap-returning via the return-node path, and the
	// monomorphized call's `owned_return`/type annotations are unset (a bare
	// variable receiver's type isn't substituted after mono). Detect it by the
	// mangled name (the only owning-string move primitive today).
	if (method_name === "Buffer_string_move_T") {
		status.last_result_is_heap = true;
	}

	if (return_struct) {
		status.code += `add x0, x29, #${temp_offset}\n`;
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
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else if (status.heap_array_vars?.has(name)) {
			// Heap-allocated array: the variable holds a pointer to a malloc'd
			// buffer with an 8-byte length prefix, then the data. Dereference
			// and skip the prefix so x19 ends up at the first element (matching
			// the inline storage a stack array would have).
			emit_var_address(status, "x0", name);
			status.code += `ldr x0, [x0]\n`;
			status.code += `add x0, x0, #8\n`;
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	// Save x19, x20
	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `str x20, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;

	// Allocate result buffer - estimate 20 bytes per int element
	const buf_size = Math.max(length * 20, 32);
	status.code += `mov x0, #${buf_size}\n`;
	emit_malloc(status);
	status.code += `mov x20, x0\n`;

	// Zero out the buffer
	status.code += `strb wzr, [x20]\n`;

	// Loop through elements
	for (let i = 0; i < length; i++) {
		// Load element
		const offset = i * element_size;
		if (element_size === 1) {
			status.code += `ldrb w0, [x19, #${offset}]\n`;
			status.code += `uxtb w0, w0\n`;
		} else {
			status.code += `ldr x0, [x19, #${offset}]\n`;
		}

		// Call int_to_string (or appropriate to_string)
		const to_string_fn = `${target_type.name}_to_string`;
		status.code += `bl ${to_string_fn}\n`;

		// Concatenate: strcat(x20, x0)
		status.code += `str x0, [sp, #-16]!\n`;
		status.code += `mov x1, x0\n`;
		status.code += `mov x0, x20\n`;
		status.code += `bl _strcat\n`;
		status.code += `ldr x0, [sp], #16\n`;
		emit_free(status);
	}

	// Return result in x0
	status.code += `mov x0, x20\n`;
	status.code += `ldr x20, [sp], #16\n`;
	status.code += `ldr x19, [sp], #16\n`;
}

function build_char_array_to_string(node: AccessNode, length: string, status: BuildStatus) {
	const len = parseInt(length);

	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else if (status.heap_array_vars?.has(name)) {
			// Heap-allocated array: the variable holds a pointer to a malloc'd
			// buffer with an 8-byte length prefix, then the data. Dereference
			// and skip the prefix so x19 ends up pointing at the first char
			// (matching the inline storage a stack array would have).
			emit_var_address(status, "x0", name);
			status.code += `ldr x0, [x0]\n`;
			status.code += `add x0, x0, #8\n`;
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;
	status.code += `mov x0, #${len + 1}\n`;
	emit_malloc(status);

	for (let i = 0; i < len; i++) {
		status.code += `ldrb w1, [x19, #${i}]\n`;
		status.code += `strb w1, [x0, #${i}]\n`;
	}
	status.code += `strb wzr, [x0, #${len}]\n`;
	status.code += `ldr x19, [sp], #16\n`;
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
