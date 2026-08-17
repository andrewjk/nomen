import add_error from "../add_error.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type CheckStatus from "./CheckStatus.ts";
import { monomorphize_enum } from "./utils/enum_mono.ts";
import type_from_value from "./utils/type_from_value.ts";

export default function check_value_node(node: ValueNode, status: CheckStatus): boolean {
	if (node.value === "null") {
		node.type = new Type("null", true);
		node.type.is_nullable = true;
		return true;
	}

	if (node.value.startsWith(".") && node.value.length > 1 && !node.value.startsWith("..")) {
		return check_enum_shorthand(node, status);
	}

	node.type = type_from_value(node.value, status);

	if (!node.type.name) {
		add_error(status, `Unknown value: ${node.value}`, node.start);
		return false;
	}

	if (status.moved_variables?.has(node.value)) {
		add_error(status, `Variable '${node.value}' used after move`, node.start);
		return false;
	}

	const decl_index = status.values.findLastIndex((v) => v.name === node.value);
	const decl_value = decl_index >= 0 ? status.values[decl_index] : undefined;
	// Nomen does not implement closures: a nested function may not reference
	// an enclosing function's locals/params. Such entries sit below the
	// current function's value base (set in check_function_node) and are not
	// module globals — globals are file-scope in the generated code, so
	// accessing one from any function is fine.
	if (decl_value && decl_index < status.function_value_base && !decl_value.is_global) {
		add_error(
			status,
			`Nested function cannot capture outer local '${node.value}'; closures are not supported — pass it as a parameter`,
			node.start,
		);
		return false;
	}
	if (decl_value?.borrow_invalidated && !status.is_assignment_target) {
		const owner = decl_value.borrowed_from ? ` of '${decl_value.borrowed_from}'` : "";
		add_error(
			status,
			`Borrow '${node.value}' was invalidated by a mutation of its owner${owner}; re-fetch it after the mutation`,
			node.start,
		);
		return false;
	}
	if (decl_value?.is_null && !status.allow_null_value && !status.is_assignment_target) {
		add_error(status, `Variable '${node.value}' may be null`, node.start);
		return false;
	}

	// Check that var declarations are initialized before use (skip assignment targets)
	// Arrays are exempt — they have allocated stack space even without an initializer
	if (
		decl_value &&
		decl_value.is_set === false &&
		decl_value.declaration === "var" &&
		!decl_value.type.is_array &&
		!status.is_assignment_target &&
		!status.allow_null_value
	) {
		add_error(status, `Variable '${node.value}' is not initialized`, node.start);
		return false;
	}

	return true;
}

function check_enum_shorthand(node: ValueNode, status: CheckStatus): boolean {
	const case_name = node.value.substring(1);
	const expected = status.expected_type;

	if (!expected?.name) {
		add_error(status, `Cannot resolve .${case_name} without a type hint`, node.start);
		return false;
	}

	let enum_node = status.enums.find((e) => e.name === expected.name);
	if (enum_node?.is_generic) {
		// A generic enum as the expected type resolves through its concrete
		// instantiation (`.none` against `Option<int>` → the `Option_int` mono).
		const mono =
			expected.type_args?.length === enum_node.type_params.length
				? monomorphize_enum(enum_node, expected.type_args, status)
				: null;
		if (!mono) {
			add_error(
				status,
				`Cannot resolve .${case_name}: generic enum ${enum_node.name} requires concrete type arguments`,
				node.start,
			);
			return false;
		}
		enum_node = mono;
	}
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === case_name);
		if (enum_case) {
			node.type = new Type(enum_node.name);
			node.value = `${enum_node.name}_${case_name}`;
			node.is_enum_shorthand = true;
			return true;
		} else {
			add_error(status, `Unknown enum case: .${case_name} on ${enum_node.name}`, node.start);
			return false;
		}
	}

	const bitset_node = status.bitsets.find((b) => b.name === expected.name);
	if (bitset_node) {
		if (bitset_node.cases.includes(case_name)) {
			node.type = new Type(expected.name);
			node.value = `${expected.name}_${case_name}`;
			node.is_enum_shorthand = true;
			return true;
		} else {
			add_error(status, `Unknown bitset case: .${case_name} on ${expected.name}`, node.start);
			return false;
		}
	}

	add_error(status, `Type ${expected.name} is not an enum or bitset`, node.start);
	return false;
}
