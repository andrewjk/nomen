import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_owned_string_branch_value } from "../build_common/string_return_analysis.ts";
import LetNode from "../nodes/LetNode.ts";
import { get_source_address } from "./build_assignment_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_strdup } from "./utils/audit.ts";
import { ensure_newline } from "./utils/code_buffer.ts";
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
	if (status.return_assign && status.return_assign_struct_size) {
		const value = node.value;
		const joins_through_branches =
			value.node_type === "if" || value.node_type === "match" || value.node_type === "switch";
		if (joins_through_branches) {
			build_node(value, status);
			return;
		}
		get_source_address(value, status);
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
