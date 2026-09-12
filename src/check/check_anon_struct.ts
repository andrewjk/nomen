import add_error from "../add_error.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { get_or_create_anon_struct } from "./utils/anon_struct.ts";
import hoist_struct_params from "./utils/hoist_struct_params.ts";
import { is_owning_struct_type } from "./utils/ownership.ts";
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
 * A literal with a base, `[ .. <expr>, field = value, ... ]`, is checked
 * here too. When the base is a struct constructor call the node is rewritten
 * to that call with validated `field_overrides` (the construction pipeline);
 * any other value-struct base (factory call, plain variable) keeps the
 * AnonStructNode — the destination sites emit a copy of the base through the
 * ordinary assignment path (which enforces the owning-struct copy/move rule)
 * followed by the override assignments.
 */
export default function check_anon_struct(node: AnonStructNode, status: CheckStatus): boolean {
	if (node.base) {
		return check_anon_struct_with_base(node, status);
	}
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
 * Check `[ .. <base>, field = value, ... ]`. A constructor-call base collapses
 * onto the call as validated `field_overrides` — the exact shape the
 * destination sites already handle, so every position (declaration,
 * assignment, return, call argument) reuses the proven pipeline unchanged.
 * Other value-struct bases are validated here and built by the destination
 * sites as a base copy + override assignments.
 */
function check_anon_struct_with_base(node: AnonStructNode, status: CheckStatus): boolean {
	const old_expected = status.expected_type;
	status.expected_type = undefined;
	if (!check_node(node.base!, status)) {
		status.expected_type = old_expected;
		return false;
	}
	const base_type = type_from_value_node(node.base!, status);
	const struct = base_type?.name
		? status.structs.findLast((s) => s.name === base_type.name && !s.is_simple_type)
		: undefined;
	if (!struct || struct.is_class) {
		add_error(
			status,
			`'${base_type?.name ?? "expression"}' is not a value struct — '[ .. expr, ... ]' needs a struct base`,
			node.base!.start,
		);
		status.expected_type = old_expected;
		return false;
	}
	// A bare-variable base is a COPY — the same rule as `var a = b`: an
	// owning struct cannot be byte-copied (both copies would free the same
	// backing data). `move` transfers ownership; a constructor/factory base
	// is a fresh value, so no gate applies.
	if (
		node.base!.node_type === "value" &&
		!(node.base! as { is_moved?: boolean }).is_moved &&
		is_owning_struct_type(base_type, status)
	) {
		add_error(
			status,
			`cannot copy '${base_type.name}' by value — it owns heap resources; use .copy() or move`,
			node.base!.start,
		);
		status.expected_type = old_expected;
		return false;
	}

	const seen = new Set<string>();
	let result = true;
	for (const field of node.fields) {
		if (seen.has(field.name)) {
			add_error(status, `Duplicate field "${field.name}" in anonymous struct`, node.start);
			result = false;
			continue;
		}
		seen.add(field.name);
		const target = struct.fields.find((f) => f.name === field.name);
		if (!target) {
			add_error(
				status,
				`Unknown field '${field.name}' in [ ... ] overrides for ${struct.name}`,
				field.value.start,
			);
			result = false;
			continue;
		}
		// Only defaulted fields may be overridden: a field without a default
		// is established by #init (possibly computed, e.g. `sum = x + y`) and
		// must not be clobbered after construction.
		if (!target.value) {
			add_error(
				status,
				`Field '${field.name}' has no default; set it in ${struct.name}(...)`,
				field.value.start,
			);
			result = false;
			continue;
		}
		status.expected_type = target.type;
		if (!check_node(field.value, status)) {
			result = false;
		}
		field.type = target.type;
	}
	status.expected_type = old_expected;
	node.type = new Type(struct.name);

	const base_call = node.base as unknown as FunctionCallNode;
	if (
		base_call.node_type === "func_call" &&
		status.structs.some((s) => s.name === base_call.name && !s.is_simple_type)
	) {
		// `T(a, b) + [ a = 1 ]` was rejected as a likely typo — keep that rule:
		// an #init parameter is set positionally by the base, not overridden.
		const init_params = struct.functions.find((f) => f.name === "#init")?.params ?? [];
		for (const field of node.fields) {
			if (init_params.some((p) => p.name === field.name)) {
				add_error(
					status,
					`'${field.name}' is a ${struct.name}(...) parameter, not a [ ... ] override`,
					field.value.start,
				);
				result = false;
			}
		}
		base_call.field_overrides = node.fields.map((f) => ({
			name: f.name,
			value: f.value,
			type: f.type,
		}));
		replace_in_place(node, base_call);
		// replace_in_place mirrors a fixed set of properties — carry the
		// validated overrides over too, or the build sites won't see them.
		(node as unknown as FunctionCallNode).field_overrides = base_call.field_overrides;
	}
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
