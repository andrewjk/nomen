import add_error from "../add_error.ts";
import { scan_string_escapes } from "../build_common/string_escapes.ts";
import { set_resolved_function } from "../nodes/set_resolved_function.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type CheckStatus from "./CheckStatus.ts";
import type StackValue from "./StackValue.ts";
import { find_mono_enum, monomorphize_enum } from "./utils/enum_mono.ts";
import { is_class_type, is_owning_struct_type } from "./utils/ownership.ts";
import type_from_value from "./utils/type_from_value.ts";

/**
 * Why a captured outer value cannot be captured, or undefined when the capture
 * is supported. Phase 2a supports COPY captures of scalars and non-owning
 * value structs (their bytes go straight into the env). Owned captures
 * (strings, owning structs, classes, traits — which need an env destructor),
 * borrowed parameters (`ref`/`var`), arrays/views/pointers, and nested closures
 * are follow-ups (docs/CLOSURE_PLAN.md).
 */
function capture_rejection(value: StackValue, status: CheckStatus): string | undefined {
	const type = value.type;
	if (type.is_ref) return "a `ref`/`var` parameter is a borrow — capturing borrows comes later";
	if (type.is_view) return "views are borrowed slices";
	if (type.is_array) return "arrays are heap-backed";
	if (type.is_pointer) return "raw pointers are not capturable";
	if (type.name === "string") return "strings are owned — owned captures come later";
	if (type.name === "func") return "capturing a closure comes later";
	if (test_type_names.includes(type.name)) return `a ${type.name} value is not capturable`;
	if (is_class_type(type.name, status)) return "classes are owned — owned captures come later";
	if (status.traits.find((t) => t.name === type.name)) return "traits are owned at runtime";
	if (is_owning_struct_type(type, status)) return "owning structs are not copyable";
	// Phase 2a supports scalar captures only (8-byte env fields on both
	// backends); struct captures are a follow-up.
	if (status.structs.find((s) => s.name === type.name && !s.is_simple_type)) {
		return "capturing a struct comes later";
	}
	return undefined;
}

const test_type_names = ["null", "void", "?"];

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

	// Degenerate string-literal escapes are rejected rather than silently
	// diverging between the length counter's pair-counting and what
	// clang/GAS actually decode (see build_common/string_escapes.ts).
	if (node.value.startsWith('"')) {
		for (const issue of scan_string_escapes(node.value)) {
			add_error(status, issue, node.start);
		}
	}
	// A function referenced as a VALUE (`apply(multiply, 4)`, `var func f = g`)
	// resolves through this node in the build's value paths. Stamp the
	// concrete FunctionNode so emitters can use its emission label (nested
	// funcs emit under `<parent>_<name>`, not the bare source name).
	if (node.type.name === "func") {
		const fn = status.functions.findLast((f) => f.name === node.value);
		if (fn?.label_name) set_resolved_function(node, fn);
	}

	if (status.moved_variables?.has(node.value)) {
		add_error(status, `Variable '${node.value}' used after move`, node.start);
		return false;
	}

	const decl_index = status.values.findLastIndex((v) => v.name === node.value);
	const decl_value = decl_index >= 0 ? status.values[decl_index] : undefined;
	// A reference below the current function's value base (set in
	// check_function_node) is a capture: legal inside a closure lambda — record
	// it on the enclosing lambda (docs/CLOSURE_PLAN.md Phase 2) — but an error
	// in a plain nested function. Module globals are file-scope in the
	// generated code, so accessing one from any function is fine.
	if (decl_value && decl_index < status.function_value_base && !decl_value.is_global) {
		const lambda = status.enclosing_closure;
		if (!lambda) {
			add_error(
				status,
				`Nested function cannot capture outer local '${node.value}'; closures are not supported — pass it as a parameter`,
				node.start,
			);
			return false;
		}
		const unsupported = capture_rejection(decl_value, status);
		if (unsupported) {
			add_error(status, `Cannot capture '${node.value}' in a closure: ${unsupported}`, node.start);
			return false;
		}
		if (!lambda.captures!.some((c) => c.name === node.value)) {
			lambda.captures!.push({ name: node.value, type: decl_value.type });
		}
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

	// A rewritten mono annotation may reference an enum that was registered in
	// a cloned check scope whose enums died with it — find_mono_enum recovers
	// it from root.statements.
	let enum_node = find_mono_enum(expected.name, status);
	if (!enum_node) {
		enum_node = status.enums.find((e) => e.name === expected.name);
	}
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
