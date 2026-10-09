import { struct_needs_auto_destroy } from "../../build_common/destroy_analysis.ts";
import {
	direct_string_fields,
	owns_strings_uniformly,
} from "../../build_common/has_string_fields.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import build_node from "../build_node.ts";
import type BuildStatus from "../BuildStatus.ts";
import { find_decl_in_c_scopes } from "./c_scope.ts";
import { begin_code_scratch, end_code_scratch } from "./code_scratch.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Resolve the concrete value-struct type of a call/case argument, if it is
 * one. Bare variables' `ValueNode.type` can be unset after monomorphization,
 * so the declaration is consulted first (mirroring the method-call mv gates).
 * Returns undefined for class/trait handles, scalars, and unresolved types.
 */
export function value_struct_arg_type(status: BuildStatus, arg: BaseNode): StructNode | undefined {
	let type_name: string | undefined;
	if (arg.node_type === "value") {
		const value = (arg as ValueNode).value;
		const hit = find_decl_in_c_scopes(status, value);
		type_name = hit?.frame[hit.index].type?.name ?? (arg as ValueNode).type?.name;
	} else {
		type_name = type_from_value_node(arg)?.name;
	}
	if (!type_name) return undefined;
	return status.structs.find(
		(s) => s.name === type_name && !s.is_simple_type && !s.is_class && !s.is_generic,
	);
}

/**
 * Emit a boxed heap handle for a concrete value-struct argument moved into a
 * trait-typed slot (an enum case payload or a `mv Trait` parameter). The
 * trait slot owns a heap instance whose first word is the conformer's vtable,
 * so an inline value struct is materialized as a malloc'd copy; unrecorded
 * (rodata/borrow) string fields are strdup'd in place first (the box's destroy
 * frees every string field), and the checker stamped the argument mv-owned
 * so the donor's own reclaim is suppressed. Emits a GNU statement expression
 * of type `void *`.
 */
export function emit_boxed_value_struct_c(
	status: BuildStatus,
	arg: BaseNode,
	box_struct: StructNode,
): void {
	const donor_name = arg.node_type === "value" ? (arg as ValueNode).value : undefined;
	// strdup only when the box's destroy slot will free the fields (user
	// `#destroy` or the auto destroy) AND the source is not uniformly heap.
	// An OWNING struct's direct string fields are uniformly heap, and the
	// mv transfers them to the box — strdup'ing would orphan the donor's
	// copy (LEAK). Mirrors the C declaration boxing (build_declaration_node).
	const strdup_string_fields =
		!owns_strings_uniformly(box_struct) &&
		!box_struct.functions.some((f) => f.name === "#destroy") &&
		struct_needs_auto_destroy(box_struct, status);
	const string_fields = strdup_string_fields ? direct_string_fields(box_struct) : [];
	const recorded = new Set<string>();
	if (donor_name) {
		for (const key of status.heap_string_fields ?? []) {
			if (key.startsWith(`${donor_name}.`)) recorded.add(key.slice(donor_name.length + 1));
		}
	}
	const unrecorded = string_fields.filter((f) => !recorded.has(f.name));
	// A fresh direct constructor builds straight into the box (`*_box =
	// T_init(args)`): the call result has no address to take, and the box
	// would otherwise alias the constructor's temporary.
	if (arg.node_type === "func_call" && (arg as FunctionCallNode).name === box_struct.name) {
		status.code += `(void *)({ struct ${box_struct.name} *_box = (struct ${box_struct.name} *)nomen_malloc_wrap(sizeof(struct ${box_struct.name})); *_box = `;
		build_node(arg, status);
		status.code += `; `;
		for (const f of unrecorded) {
			status.code += `_box->${f.name} = nomen_str_dup(_box->${f.name}); `;
		}
		status.code += `(void *)_box; })`;
		return;
	}
	const saved_arg = begin_code_scratch(status);
	status.code += `(void *)&`;
	status.suppress_dereference = true;
	build_node(arg, status);
	status.suppress_dereference = false;
	const addr_text = end_code_scratch(status, saved_arg);
	status.code += `(void *)({ struct ${box_struct.name} *_src = (struct ${box_struct.name} *)${addr_text}; `;
	for (const f of unrecorded) {
		status.code += `_src->${f.name} = nomen_str_dup(_src->${f.name}); `;
	}
	status.code += `struct ${box_struct.name} *_box = (struct ${box_struct.name} *)nomen_malloc_wrap(sizeof(struct ${box_struct.name})); `;
	status.code += `*_box = *_src; `;
	status.code += `(void *)_box; })`;
}

/**
 * If `arg` is a concrete value-struct conformer and the target slot is typed a
 * trait, emit the boxed handle and return true; otherwise return false (the
 * caller emits the plain pointer/value). `trait_name` is the target slot's
 * declared type.
 */
export function try_emit_boxed_trait_arg_c(
	status: BuildStatus,
	arg: BaseNode,
	trait_name: string | undefined,
): boolean {
	if (!trait_name || !status.traits.find((t) => t.name === trait_name)) return false;
	const arg_struct = value_struct_arg_type(status, arg);
	if (!arg_struct) return false;
	emit_boxed_value_struct_c(status, arg, arg_struct);
	return true;
}
