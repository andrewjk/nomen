import flatten_null_chain from "../build_common/null_chain.ts";
import { is_nullable_scalar_type } from "../build_common/nullable_scalar.ts";
import { has_flag_name, is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type NullAccessNode from "../nodes/NullAccessNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import { begin_code_scratch, end_code_scratch } from "./utils/code_scratch.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

let chain_tmp_counter = 0;

/** Ensure the flattened chain's hop nodes carry their nullable types (the
 *  checker stamps the VALUE path; hops reuse those nodes, but a bare base
 *  value keeps its binding type). */
export function emit_chain_tests(hops: BaseNode[], status: BuildStatus): string {
	const parts: string[] = [];
	for (const hop of hops) {
		const t = type_from_value_node(hop);
		// Only NULLABLE hops carry a condition: a non-nullable member's chain
		// result is null exactly when an earlier hop is, already tested.
		if (!t?.is_nullable) continue;
		if (t.name === "string") {
			// In-band null: the fat ptr half.
			const saved = begin_code_scratch(status);
			build_node(hop, status);
			const expr = end_code_scratch(status, saved);
			parts.push(`(${expr}.ptr != 0)`);
		} else {
			parts.push(`(${build_nullable_has(hop, status)})`);
		}
	}
	return parts.join(" && ");
}

/** Whether a hop's nullable representation is the companion `_has` flag
 *  (scalars and inline structs) rather than the in-band string null.
 *  Mirrors build_operation_node's build_nullable_has (kept here to avoid a
 *  build-order cycle): a nullable local/param's flag is the sibling
 *  `<name>_has` C variable; any other lvalue builds + appends `_has`. */
function build_nullable_has(node: BaseNode, status: BuildStatus): string {
	if (node.node_type === "value") {
		const name = (node as unknown as { value: string }).value;
		const t = type_from_value_node(node);
		if (is_nullable_struct_type(t, status) || is_nullable_scalar_type(t, status)) {
			return has_flag_name(name);
		}
	}
	const saved = begin_code_scratch(status);
	build_node(node, status);
	const expr = end_code_scratch(status, saved);
	return `${expr}_has`;
}

/**
 * Lower a nullable chain as a nullable VALUE (the ERRORS_PLAN v2 growth:
 * chains are no longer consumed-only). A GCC statement-expression evaluates
 * the chain ONCE and yields the member's value, writing the nullness into
 * the per-slot carrier:
 *
 * - a string member's null is IN-BAND — the fat zero pair `{0, 0}`;
 * - a scalar/struct member rides the companion `_has` flag — the consumer's
 *   pre-allocated flag when `current_nullable_call_flag` is set (the same
 *   protocol a nullable-returning call uses), else a synthesized throwaway.
 *
 * Ownership mirrors `??`: the string value arm is dup'd into an independently
 * owned copy (a call result — a producer — transfers instead), so the result
 * feeds consumers that free it (let bindings, return boundaries, args).
 * Struct payloads alias exactly like assignment; scalars copy.
 */
export function build_null_chain_value_c(node: NullAccessNode, status: BuildStatus): void {
	const flat = flatten_null_chain(node, (t, f) => {
		const st = status.structs.findLast((s) => s.name === t && !s.is_generic);
		return st?.fields.find((fld) => fld.name === f)?.type;
	});
	if (!flat) {
		// Not a flattenable chain — the checker only stamps real ones.
		return;
	}
	const t = node.type;
	const id = chain_tmp_counter++;
	const is_str = t?.name === "string" && !t.is_view;
	const is_struct =
		!!t?.name &&
		!!status.structs.find(
			(st) => st.name === t.name && !st.is_simple_type && !st.is_class && !st.is_generic,
		);
	// The value arm's ownership: a call (free function or method) transfers
	// its fresh result; an access path aliases its owner and is dup'd.
	const value_is_producer =
		flat.value.node_type === "func_call" ||
		(flat.value.node_type === "access" &&
			(flat.value as AccessNode).access.node_type === "access_func");
	if (is_str) {
		status.code += `({ nomen_string _ncv_${id} = {0, 0}; if (`;
		status.code += emit_chain_tests(flat.hops, status);
		status.code += `) { _ncv_${id} = `;
		if (!value_is_producer) status.code += `nomen_str_dup(`;
		build_node(flat.value, status);
		if (!value_is_producer) status.code += `)`;
		status.code += `; } _ncv_${id}; })`;
		return;
	}
	const c_t = is_struct ? `struct ${t!.name}` : c_type(t?.name || "long");
	// The nullness carrier: the consumer's flag (declaration/assignment/
	// return sites pre-allocate it and its name is in scope), else a
	// throwaway declared in the statement-expression itself (the value is
	// consumed without its nullness — a statement-position discard).
	const consumer_flag = status.current_nullable_call_flag;
	const flag = consumer_flag ?? `_nch_${id}`;
	status.code += `({ ${c_t} _ncv_${id} = ${is_struct ? "{0}" : "0"}; `;
	if (!consumer_flag) status.code += `unsigned char ${flag} = 0; `;
	status.code += `if (`;
	status.code += emit_chain_tests(flat.hops, status);
	status.code += `) { _ncv_${id} = `;
	build_node(flat.value, status);
	status.code += `; ${flag} = 1; } else { ${flag} = 0; } _ncv_${id}; })`;
}
