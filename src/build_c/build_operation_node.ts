import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import { is_nullable_struct_type } from "./utils/nullable_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_operation_node(node: OperationNode, status: BuildStatus) {
	if (node.op === "!") {
		status.code += `!`;
		build_node(node.right_value, status);
	} else if (node.op === "u-") {
		// Unary minus: emit C unary `-`. The operand is wrapped by the binary
		// builder if it's itself an operation; otherwise (variable/call/access)
		// C's unary `-` binds tighter than any binary operator, so no parens
		// are needed.
		status.code += `-`;
		build_node(node.right_value, status);
	} else if (node.op === "??") {
		// `nullable ?? fallback`. For a nullable struct, the flag is `<expr>_has`.
		const left_type = type_from_value_node(node.left_value);
		if (is_nullable_struct_type(left_type, status)) {
			status.code += `(`;
			status.code += build_nullable_has(node.left_value, status);
			status.code += ` ? `;
			build_node(node.left_value, status);
			status.code += ` : `;
			build_node(node.right_value, status);
			status.code += `)`;
		} else {
			status.code += `(`;
			build_node(node.left_value, status);
			status.code += ` ? `;
			build_node(node.left_value, status);
			status.code += ` : `;
			build_node(node.right_value, status);
			status.code += `)`;
		}
	} else if ((node.op === "==" || node.op === "!=") && is_null_comparison(node)) {
		// `x == null` / `x != null` against a nullable struct lowers to its
		// companion `_has` flag rather than comparing the struct value to 0.
		const nullable_side = is_nullable_struct_side(node.left_value, status)
			? node.left_value
			: node.right_value;
		const type = type_from_value_node(nullable_side);
		if (is_nullable_struct_type(type, status)) {
			const has = build_nullable_has(nullable_side, status);
			// `== null` → !has ; `!= null` → has
			status.code += node.op === "==" ? `(!${has})` : `(${has})`;
		} else {
			build_default_binary(node, status);
		}
	} else if (node.operator_func) {
		// Custom operator function call
		const label =
			node.operator_func.mangled_name ||
			`${node.operator_func.struct_name}_${node.operator_func.func_name}`;
		// String concat/repeat (`a + b`, `s * n`): if an operand is itself a
		// freshly-allocated heap string temp (a nested string op or a
		// heap-returning call), it is never bound to a variable and would leak
		// once the operator has consumed it. Emit a statement-expression that
		// captures each such temp, runs the operator, frees the temps, and
		// yields the result. Mirrors the aarch64 backend's is_owned_heap_temp
		// spill-and-free. (Builds link with clang, which supports GNU
		// statement expressions.)
		const is_string_op = node.type?.name === "string";
		const left_temp = is_string_op && is_owned_heap_temp(node.left_value, status);
		const right_temp = is_string_op && is_owned_heap_temp(node.right_value, status);
		if (left_temp || right_temp) {
			const id = (status.label_counter = (status.label_counter ?? 0) + 1);
			const lt = `_ltmp_${id}`;
			const rt = `_rtmp_${id}`;
			status.code += `({ `;
			status.code += `char* ${lt} = `;
			build_operand(node.left_value, status);
			status.code += `; char* ${rt} = `;
			build_operand(node.right_value, status);
			status.code += `; char* _cres_${id} = ${label}(${lt}, ${rt}); `;
			if (left_temp) status.code += `free(${lt}); `;
			if (right_temp) status.code += `free(${rt}); `;
			status.code += `_cres_${id}; })`;
		} else {
			const is_array_op =
				node.operator_func.struct_name.startsWith("Array") &&
				(type_from_value_node(node.left_value).is_array ||
					type_from_value_node(node.right_value).is_array);
			// `!=` dispatched to a struct's `eq` (or `==` to `ne`): wrap the
			// call result in a logical NOT.
			if (node.operator_func.invert) status.code += `(!`;
			if (is_array_op) {
				status.code += `${label}(`;
				build_array_operand_for_call(node.left_value, status);
				status.code += ", ";
				build_array_operand_for_call(node.right_value, status);
				status.code += ")";
			} else {
				status.code += `${label}(`;
				build_operand(node.left_value, status);
				status.code += ", ";
				build_operand(node.right_value, status);
				status.code += ")";
			}
			if (node.operator_func.invert) status.code += `)`;
		}
	} else {
		build_default_binary(node, status);
	}
}

/**
 * Whether an operand produces a fresh heap string that is safe to free once a
 * string operator has consumed it: a nested string op (`a + b`), a string
 * interpolation, a `*_to_string` call, or a call registered in
 * heap_returning_functions. Variables, literals and arbitrary calls are NOT
 * freed here — they may be static or owned elsewhere. Mirrors the aarch64
 * backend's is_owned_heap_temp.
 */
export function is_owned_heap_temp(
	node: import("../nodes/BaseNode.ts").default,
	status: BuildStatus,
): boolean {
	let check_node = node;
	let target_value: string | undefined;
	let target_type_name: string | undefined;
	let type_name = (node as { type?: { name?: string } }).type?.name;
	if (node.node_type === "access") {
		const access = node as unknown as {
			access?: { node_type?: string; type?: { name?: string }; name?: string };
			target?: { value?: string; type?: { name?: string } };
		};
		if (access.access?.node_type !== "access_func") return false;
		target_value = access.target?.value;
		target_type_name = access.target?.type?.name;
		if (!target_type_name && (node as any).target) {
			try {
				target_type_name = type_from_value_node((node as any).target)?.name;
			} catch {
				target_type_name = undefined;
			}
		}
		check_node = access.access as unknown as import("../nodes/BaseNode.ts").default;
		// The result type may be recorded on the inner access_func node or on
		// the outer AccessNode — fall back to the latter.
		type_name = access.access?.type?.name || type_name;
	}
	if (type_name !== "string") return false;
	if (check_node.node_type === "op") return true;
	if (check_node.node_type === "func_call" || check_node.node_type === "access_func") {
		const raw_name = (check_node as unknown as { name: string }).name;
		const mangled = (check_node as unknown as { mangled_name?: string }).mangled_name || raw_name;
		if (mangled.startsWith("_string_interpolate_")) return true;
		if (mangled.endsWith("_to_string") && mangled !== "string_to_string") return true;
		// A bare `.to_string()` on a non-string target (emitted as
		// `<type>_to_string`) returns a fresh owned heap string; the AST method
		// name lacks the type prefix, so match via the target's type.
		if (raw_name === "to_string" && target_type_name && target_type_name !== "string") return true;
		const heap_set = status.heap_returning_functions;
		if (heap_set?.has(mangled)) return true;
		if (heap_set && target_value && heap_set.has(`${target_value}_${raw_name}`)) return true;
		// A method call `obj.method()` is mangled as `<StructType>_method`
		// (e.g. `Frank_hello`) in heap_returning_functions. The receiver's
		// struct type name lets us reconstruct that mangled name.
		if (heap_set && target_type_name && heap_set.has(`${target_type_name}_${raw_name}`))
			return true;
		// The C backend strdup's EVERY string return (see build_return_node),
		// so any string-returning call produces an owned heap string — even
		// when the mangled name couldn't be matched (e.g. a trait default
		// method resolved as `<Trait>_<method>` rather than
		// `<Struct>_<method>`). The only string calls that are NOT owned are
		// borrows: `.at()`/`.first()` return a pointer into the receiver's
		// storage rather than a fresh allocation.
		const is_borrow =
			check_node.node_type === "access_func" &&
			(raw_name === "at" || raw_name === "first") &&
			!(check_node as unknown as { owned_return?: boolean }).owned_return;
		return !is_borrow;
	}
	return false;
}

function build_default_binary(node: OperationNode, status: BuildStatus) {
	// Wrap binary operations in parens so C's precedence can't misinterpret
	// them when they're nested as operands of other expressions.
	status.code += `(`;
	build_node(node.left_value, status);
	status.code += ` ${node.op} `;
	build_node(node.right_value, status);
	status.code += `)`;
}

/** True if one side of an ==/!= is the `null` literal. */
function is_null_comparison(node: OperationNode): boolean {
	const l = node.left_value;
	const r = node.right_value;
	const l_null = l.node_type === "value" && (l as ValueNode).value === "null";
	const r_null = r.node_type === "value" && (r as ValueNode).value === "null";
	return l_null || r_null;
}

function is_nullable_struct_side(node: any, status: BuildStatus): boolean {
	return is_nullable_struct_type(type_from_value_node(node), status);
}

/**
 * Build the companion `_has` flag expression for a nullable-struct lvalue by
 * building the lvalue's C expression and appending `_has`. This works because
 * every nullable-struct lvalue (a bare variable or a `.field`/`->field` access)
 * ends in an identifier.
 */
function build_nullable_has(node: any, status: BuildStatus): string {
	const before = status.code.length;
	build_node(node, status);
	const expr = status.code.substring(before);
	status.code = status.code.substring(0, before);
	return `${expr}_has`;
}

function build_operand(node: any, status: BuildStatus) {
	const param_type = type_from_value_node(node);
	const is_struct =
		status.structs.find((s) => s.name === param_type.name && !s.is_simple_type) ||
		status.traits.find((t) => t.name === param_type.name);
	if (!is_struct) {
		build_node(node, status);
		return;
	}
	// Struct/trait operands are passed by address. If the operand is already an
	// lvalue (a variable or member/element access) we can take its address
	// directly. Otherwise it's an rvalue (e.g. a freshly-constructed struct
	// `M(5)`, an arithmetic result, or a cast) and `&<rvalue>` is invalid C —
	// materialize it into a temporary first via a GCC statement-expression.
	const is_lvalue =
		node.node_type === "value" ||
		node.node_type === "access" ||
		node.node_type === "access_field" ||
		node.node_type === "access_func";
	if (is_lvalue) {
		status.code += `&`;
		build_node(node, status);
	} else {
		const tag = param_type.name;
		status.code += `({ ${tag} _op_tmp = `;
		build_node(node, status);
		status.code += `; &_op_tmp; })`;
	}
}

/**
 * Build an operand for an Array operator call. Stack arrays and inline array
 * literals are wrapped in a temporary `struct Array_int` header so the
 * monomorphized C function receives a proper `struct Array_int*` pointer.
 * Heap arrays (already `struct Array_int*`) are passed by address as usual.
 */
function build_array_operand_for_call(node: any, status: BuildStatus) {
	const param_type = type_from_value_node(node);
	const is_heap_array =
		node.node_type === "value" && status.heap_array_vars?.has((node as ValueNode).value);
	if (is_heap_array) {
		build_operand(node, status);
		return;
	}
	const is_stack_array =
		param_type.is_array &&
		node.node_type === "value" &&
		!status.heap_array_vars?.has((node as ValueNode).value);
	const is_inline_literal = node.node_type === "array";
	if (!is_stack_array && !is_inline_literal) {
		build_operand(node, status);
		return;
	}
	const elem_c_type = c_type(param_type.name);
	let length: string;
	if (is_stack_array) {
		length = status.stack_array_lengths?.get((node as ValueNode).value) || "1";
	} else {
		length = String((node as ArrayValuesNode).values.length);
	}
	// Fallback: use compile-time type length if available
	if (length === "1" && param_type.length) {
		const before = status.code.length;
		build_node(param_type.length, status);
		length = status.code.substring(before);
		status.code = status.code.substring(0, before);
	}
	const id = (status.label_counter = (status.label_counter ?? 0) + 1);
	const wrap = `_arrwrap_${id}`;
	status.code += `({ struct { struct Array_int _h; ${elem_c_type} _d[${length}]; } ${wrap}; `;
	status.code += `${wrap}._h._vt = 0; ${wrap}._h.length = ${length}; `;
	if (is_stack_array) {
		status.code += `memcpy(${wrap}._d, ${(node as ValueNode).value}, ${length} * sizeof(${elem_c_type})); `;
	} else {
		const values = (node as ArrayValuesNode).values;
		for (let i = 0; i < values.length; i++) {
			status.code += `${wrap}._d[${i}] = `;
			build_node(values[i], status);
			status.code += `; `;
		}
	}
	status.code += `(struct Array_int*)&${wrap}; })`;
}
