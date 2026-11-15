import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { is_nullable_scalar_type } from "../build_common/nullable_scalar.ts";
import { is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import { is_owned_string_branch_value } from "../build_common/string_return_analysis.ts";
import LetNode from "../nodes/LetNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { get_source_address } from "./build_assignment_node.ts";
import build_node from "./build_node.ts";
import { load_nullable_has } from "./build_operation_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_strdup } from "./utils/audit.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { emit_var_address, emit_var_store } from "./utils/stack_var.ts";
import { emit_struct_copy } from "./utils/struct_layout.ts";

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations?.find((d) => d.name === name);
	if (decl?.type?.name) {
		return aarch64_size(decl.type.name);
	}
	return 8;
}

export default function build_let_node(node: LetNode, status: BuildStatus) {
	// Struct-kind join (a value struct, mv struct, or enum-with-data
	// destination): struct-valued arm expressions leave the value's ADDRESS
	// in x0 — a constructor's sret temp, a case-construction temp, a bare
	// struct variable's slot (get_source_address addresses those without
	// building them — build_node on a plain struct variable would load its
	// first word) — so the store is an address + struct copy. A nested
	// branching arm (`-> if c -> a else -> b`) joins through the SAME
	// return_assign (the prefix protocol): its own lets already stored the
	// slot, so only the nested build runs here.
	const joins_through_branches =
		node.value.node_type === "if" ||
		node.value.node_type === "match" ||
		node.value.node_type === "switch";
	// Per-arm nullable-flag join (a nullable-typed arm set on a nullable
	// slot): the arm writes the value into the join slot AND its own
	// null-ness into the slot's `_has` flag slot. A `null` arm writes the
	// flag only — the slot's value bytes stay stale (every read is
	// flag-guarded, the same contract a plain `p = null` store keeps). A
	// nested branching arm joins through its own lets, which see the same
	// flag slot.
	const flag_offset = joins_through_branches ? undefined : status.return_assign_flag_offset;
	if (flag_offset !== undefined && status.return_assign) {
		const join_target = status.return_assign;
		const value = node.value;
		if (value.node_type === "value" && (value as ValueNode).value === "null") {
			if (!status.return_assign_struct_size) {
				emit_var_store(status, "xzr", join_target, status.return_assign_size ?? 8);
			}
			emit_asm(status, `str xzr, [x29, #${flag_offset}]\n`);
			return;
		}
		if (status.return_assign_struct_size) {
			get_source_address(value, status);
			ensure_newline(status);
			emit_var_address(status, "x1", join_target);
			emit_struct_copy("x0", "x1", 0, status.return_assign_struct_size, status);
		} else {
			build_node(value, status);
			ensure_newline(status);
			emit_var_store(status, "x0", join_target, status.return_assign_size ?? 8);
		}
		store_arm_nullable_flag(value, flag_offset, status);
		return;
	}
	if (status.return_assign && status.return_assign_struct_size) {
		if (joins_through_branches) {
			build_node(node.value, status);
			return;
		}
		get_source_address(node.value, status);
		ensure_newline(status);
		emit_var_address(status, "x1", status.return_assign);
		emit_struct_copy("x0", "x1", 0, status.return_assign_struct_size, status);
		return;
	}
	build_node(node.value, status);
	if (status.return_assign) {
		ensure_newline(status);
		// Mixed string-join normalization: when the enclosing match/switch/if
		// expression has both owned (interpolation/concat/call) and non-owned
		// branches, strdup the non-owned values (a literal's rodata pointer, a
		// borrow) so the join variable uniformly owns its result — the scope
		// exit free would abort on a raw rodata/borrow pointer. if/match/switch
		// values assign the target themselves; their own branch lets see the
		// same flag.
		if (
			status.join_needs_owned_string &&
			node.value.node_type !== "if" &&
			node.value.node_type !== "match" &&
			node.value.node_type !== "switch" &&
			!is_owned_string_branch_value(node.value, status)
		) {
			emit_strdup(status);
			ensure_newline(status);
		}
		// The join slot's size comes from return_assign_size when set — the
		// join target is not in scoped_declarations (the match/if/switch arms
		// swap the frame out), so the fallback would return 8 and a fat
		// string's len half would be dropped from the join slot.
		const size = status.return_assign_size ?? find_var_size(status.return_assign, status);
		emit_var_store(status, "x0", status.return_assign, size);
	}
}

/**
 * Write an arm value's null-ness into the join slot's `_has` flag: a bare
 * variable / field forwards its own flag (load_nullable_has), a nullable
 * call's temp address is still in x0 after the struct copy (the copy only
 * uses x3), and a fresh non-nullable value lands as 1.
 */
function store_arm_nullable_flag(
	value: LetNode["value"],
	flag_offset: number,
	status: BuildStatus,
) {
	const t = type_from_value_node(value);
	const nullable_typed =
		!!t?.is_nullable && (is_nullable_struct_type(t, status) || is_nullable_scalar_type(t, status));
	if (!nullable_typed) {
		emit_asm(status, `mov x9, #1\n`);
		emit_asm(status, `str x9, [x29, #${flag_offset}]\n`);
		return;
	}
	if (value.node_type === "func_call") {
		// The call materialized its result (value + `_has`) into a temp; x0
		// still holds the temp's address (emit_struct_copy only uses x3).
		const off = is_nullable_scalar_type(t, status) ? 8 : (status.return_assign_struct_size ?? 0);
		if (off === 0) {
			// No struct size known — reload through the standard helper.
			load_nullable_has(value, "x9", status);
			ensure_newline(status);
			emit_asm(status, `str x9, [x29, #${flag_offset}]\n`);
			return;
		}
		emit_asm(status, `ldr x9, [x0, #${off}]\n`);
		emit_asm(status, `str x9, [x29, #${flag_offset}]\n`);
		return;
	}
	if (value.node_type === "value" || value.node_type === "access") {
		load_nullable_has(value, "x9", status);
		ensure_newline(status);
		emit_asm(status, `str x9, [x29, #${flag_offset}]\n`);
		return;
	}
	// Anything else is not statically null (the checker rejects mixed sets,
	// so a non-call nullable arm is a variable or a field read).
	emit_asm(status, `mov x9, #1\n`);
	emit_asm(status, `str x9, [x29, #${flag_offset}]\n`);
}
