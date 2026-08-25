import add_error from "../add_error.ts";
import {
	ALL_FLOAT_TYPES,
	ALL_INT_TYPES,
	SIGNED_FLOAT_TYPES,
	UINT_TYPES,
	type_bits,
} from "../built_in_types.ts";
import CastNode from "../nodes/CastNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

export function can_implicit_cast(from: string, to: string): boolean {
	const from_idx = ALL_INT_TYPES.indexOf(from);
	const to_idx = ALL_INT_TYPES.indexOf(to);
	if (from_idx !== -1 && to_idx !== -1) {
		if (from === to) return true;
		const from_bits = type_bits(from);
		const to_bits = type_bits(to);
		if (to_bits > from_bits) return true;
		const from_is_uint = UINT_TYPES.includes(from);
		const to_is_uint = UINT_TYPES.includes(to);
		if (from_is_uint && to_is_uint && to_bits === from_bits) return true;
		return false;
	}
	if (from_idx !== -1 && SIGNED_FLOAT_TYPES.includes(to)) return true;
	if (UINT_TYPES.includes(from) && SIGNED_FLOAT_TYPES.includes(to)) return true;
	return false;
}

export default function check_cast_node(node: CastNode, status: CheckStatus) {
	check_node(node.value, status);
	check_type_exists(node.target_type, status, node.start);

	const value_type = type_from_value_node(node.value, status);
	const from = value_type.name;
	const to = node.target_type.name;

	if (!from) {
		add_error(status, "Cannot cast unknown type", node.start);
		return;
	}
	if (!to) {
		add_error(status, "Cannot cast to unknown type", node.start);
		return;
	}
	// `as` is a closed numeric/bool/char allowlist — it is a value conversion,
	// never a way to fabricate a reference. Reject any `ref`/`view` target
	// outright so an integer value cannot be (mis)typed as a pointer (cve-rs
	// probe: `int as ref int`). Without this the checker compares only `.name`
	// ("int"), letting the cast slip through as an int→int conversion.
	if (node.target_type.is_ref || node.target_type.is_view) {
		add_error(
			status,
			`Cannot cast to ${type_name(node.target_type)}: 'as' cannot produce a reference`,
			node.start,
		);
		return;
	}
	if (from === to) return;

	const from_idx = ALL_INT_TYPES.indexOf(from);
	const to_idx = ALL_INT_TYPES.indexOf(to);
	const from_is_float = ALL_FLOAT_TYPES.includes(from);
	const to_is_float = ALL_FLOAT_TYPES.includes(to);
	const from_is_bool = from === "bool";
	const to_is_bool = to === "bool";

	if (from_idx !== -1 && to_idx !== -1) return;
	if (from_idx !== -1 && to_is_float) return;
	if (from_is_float && to_idx !== -1) return;
	if (from_is_float && to_is_float) return;
	if (from_is_bool && to_idx !== -1) return;
	if (from_idx !== -1 && to_is_bool) return;
	if (from === "char" && to_idx !== -1) return;
	if (from_idx !== -1 && to === "char") return;

	const source_struct = status.structs.find((s) => s.name === from && !s.is_simple_type);
	if (source_struct) {
		const as_func = source_struct.functions.find((f) => f.name === "as");
		if (as_func) {
			const return_type = as_func.return_type.name;
			if (return_type !== to) {
				add_error(
					status,
					`Cannot cast from ${from} to ${to}: as operator returns ${return_type}`,
					node.start,
				);
			}
			node.operator_func = {
				struct_name: from,
				func_name: "as",
			};
			return;
		}
	}

	add_error(
		status,
		`Cannot cast from ${type_name(value_type)} to ${type_name(node.target_type)}`,
		node.start,
	);
}
