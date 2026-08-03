import add_error from "../add_error.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { get_or_create_anon_struct } from "./utils/anon_struct.ts";
import hoist_struct_params from "./utils/hoist_struct_params.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Check a standalone anonymous struct literal `[ field = value, ... ]` used as
 * a first-class value. Each field's value is checked and its type inferred; the
 * literal is then materialized into an auto-generated struct (see
 * `get_or_create_anon_struct`) and the node is rewritten in place as a
 * constructor call to that struct's `#init`. Field access, destructuring,
 * assignment, return, and passing to functions then work automatically because
 * the value is an ordinary struct.
 *
 * This does not touch the `[ ... ]` overlay form `T(...) + [ ... ]`, which is
 * collapsed onto a `FunctionCallNode` as `field_overrides` at parse time.
 */
export default function check_anon_struct(node: AnonStructNode, status: CheckStatus): boolean {
	const old_expected = status.expected_type;
	status.expected_type = undefined;

	let result = true;
	const fields: { name: string; type: Type }[] = [];
	const value_by_name = new Map<string, BaseNode>();
	const seen = new Set<string>();

	for (const field of node.fields) {
		if (seen.has(field.name)) {
			add_error(status, `Duplicate field "${field.name}" in anonymous struct`, node.start);
			status.expected_type = old_expected;
			return false;
		}
		seen.add(field.name);

		if (!check_node(field.value, status)) {
			result = false;
		}
		const field_type = type_from_value_node(field.value, status);
		fields.push({ name: field.name, type: field_type });
		value_by_name.set(field.name, field.value);
	}
	status.expected_type = old_expected;

	const struct = get_or_create_anon_struct(fields, status);

	// The struct's `#init` params are in name-sorted order; pass the field
	// values in that same order.
	const sorted_names = fields.map((f) => f.name).sort((a, b) => a.localeCompare(b));
	const params = sorted_names.map((n) => value_by_name.get(n)!);

	const constructor = new FunctionCallNode(node.start, struct.name);
	constructor.params = params;
	constructor.type = new Type(struct.name);
	hoist_struct_params(constructor, status);

	replace_in_place(node, constructor);
	return result;
}

/**
 * Rewrite `target`'s own properties so any parent reference held onto the
 * `AnonStructNode` observes a `func_call` constructor instead. Mirrors the
 * tuple rewrite in `check_array_values_node.replace_in_place`.
 */
function replace_in_place(target: AnonStructNode, source: FunctionCallNode) {
	(target as any).node_type = source.node_type;
	(target as any).name = source.name;
	(target as any).type = source.type;
	(target as any).params = source.params;
	(target as any).is_static = source.is_static;
}
