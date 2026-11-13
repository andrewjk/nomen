import add_error from "../add_error.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import { has_null_chain } from "../build_common/null_chain.ts";
import { is_nullable_flagged_type } from "../build_common/nullable_scalar.ts";
import { get_built_in_type, is_negatable_type } from "../built_in_types.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import NullAccessNode from "../nodes/NullAccessNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { expression_to_source, is_inside_core_method } from "./check_function_call.ts";
import { monomorphize } from "./check_function_call_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import evaluate_const_condition from "./utils/evaluate_const_condition.ts";
import {
	apply_bounds,
	apply_negated_bounds,
	expr_to_string,
	restore_all_bounds,
	snapshot_all_bounds,
} from "./utils/flow_bounds.ts";
import {
	find_function_by_params,
	is_overloaded,
	mangled_label,
} from "./utils/function_overload.ts";
import get_null_check_var from "./utils/get_null_check_var.ts";
import hoist_struct_params from "./utils/hoist_struct_params.ts";
import { is_owning_struct_type } from "./utils/ownership.ts";
import { maybe_mark_borrow_to_string_operand } from "./utils/string_mutation_scan.ts";
import { get_or_create_tuple_struct, tuple_struct_name } from "./utils/tuple_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_operation_node(op: OperationNode, status: CheckStatus): boolean {
	if (op.op === "!") {
		if (!check_node(op.right_value, status)) {
			return false;
		}
		op.type = new Type("bool");
		return true;
	}

	// ERRORS_PLAN: postfix `!` — propagate. `expr!` must be a `Result<T, E>`
	// value; on the fail case the ENCLOSING function returns the error, so
	// that function must itself be `!`-declared with the same error enum
	// (error-set widening is composition machinery, staged). The ok case
	// yields T into the enclosing expression.
	if (op.op === "p!") {
		if (!check_node(op.left_value, status)) {
			return false;
		}
		const left_type = type_from_value_node(op.left_value, status);
		const result_enum = status.enums.findLast((e) => e.name === left_type.name);
		const ok_case = result_enum?.cases.find((c) => c.name === "ok");
		const fail_case = result_enum?.cases.find((c) => c.name === "fail");
		const left_is_result_like =
			result_enum?.template_name === "Result" || result_enum?.template_name === "UnitResult";
		if (!left_is_result_like || !fail_case?.params[0]) {
			add_error(
				status,
				`'!' propagates a 'T ! E' result — '${left_type.name || "value"}' is not a result type`,
				op.start,
			);
			return false;
		}
		// A value-less result (`UnitResult`, the `out ! E` type): `close()!`
		// propagates and yields NOTHING — allowed only in a unit-result
		// function (there is no value to yield or return).
		const left_has_payload = !!ok_case?.params[0];
		let enclosing: FunctionNode | null = null;
		for (let i = status.stack.length - 1; i >= 0; i--) {
			if (status.stack[i].node_type === "func") {
				enclosing = status.stack[i] as FunctionNode;
				break;
			}
		}
		if (!enclosing?.returns_result) {
			add_error(
				status,
				`'!' propagates to the caller — the enclosing function must declare a '!' result type`,
				op.start,
			);
			return false;
		}
		const enclosing_enum = status.enums.findLast((e) => e.name === enclosing.return_type.name);
		const enclosing_fail = enclosing_enum?.cases.find((c) => c.name === "fail");
		const enclosing_is_result_like =
			enclosing_enum?.template_name === "Result" || enclosing_enum?.template_name === "UnitResult";
		if (enclosing_fail && enclosing_is_result_like) {
			const declared_err = enclosing_fail.params[0].type;
			const operand_err = fail_case.params[0].type;
			if (mono_type_name(operand_err) !== mono_type_name(declared_err)) {
				// Composition widening: the operand's error enum must be one
				// of the enclosing set's members — the fail value wraps
				// through that member's origin tag (stamped for the
				// backends). Exact matches above ride the plain move/copy.
				const members = enclosing.result_error_types ?? [];
				const member =
					members.length > 1
						? members.find((m) => mono_type_name(m) === mono_type_name(operand_err))
						: undefined;
				const declared_enum = status.enums.findLast((e) => e.name === declared_err.name);
				const member_case = member
					? declared_enum?.cases.find((c) => c.name === member.name)
					: undefined;
				if (member && declared_enum && member_case?.params[0]) {
					op.propagate_into = {
						mono: declared_enum.name,
						case: member.name,
						field: member_case.params[0].name,
						outer_mono: enclosing_enum.name,
						outer_field: enclosing_fail.params[0].name,
					};
				} else {
					const expected =
						members.length > 1
							? `one of the set's error enums (${members.map((m) => m.name).join(", ")})`
							: `'${declared_err.name}'`;
					add_error(
						status,
						`'!' propagates '${operand_err.name}' but the enclosing function expects ${expected}`,
						op.start,
					);
					return false;
				}
			}
		}
		const propagated = new Type(
			ok_case?.params[0]?.type.name ?? "void",
			ok_case?.params[0]?.type.is_static,
			ok_case?.params[0]?.type.is_array,
			ok_case?.params[0]?.type.length,
		);
		propagated.type_args = ok_case?.params[0]?.type.type_args;
		propagated.is_ref = ok_case?.params[0]?.type.is_ref;
		propagated.is_nullable = ok_case?.params[0]?.type.is_nullable;
		if (!left_has_payload && !enclosing.unit_result) {
			add_error(
				status,
				`a value-less result cannot propagate into a function that returns a value — discard it with 'var _ =' or propagate in an 'out ! E' function`,
				op.start,
			);
			return false;
		}
		op.type = propagated;
		op.coalesce_ok_field = ok_case?.params[0]?.name;
		op.propagate_fail_field = fail_case.params[0].name;
		return true;
	}

	// Unary minus on a variable/access/call (integer literals fold their sign
	// into one token, so this is only the non-literal path). The result type is
	// the operand's type; ints/floats negate to themselves.
	if (op.op === "u-") {
		if (!check_node(op.right_value, status)) {
			return false;
		}
		op.type = type_from_value_node(op.right_value, status);
		const t = op.type.name;
		if (!is_negatable_type(t)) {
			add_error(status, `Cannot negate type ${t}`, op.start);
			return false;
		}
		return true;
	}

	if (op.op === ("&&" as const)) {
		if (!check_node(op.left_value, status)) return false;

		// Short-circuit: narrow is_null when left side is thing != null
		const left_check = get_null_check_var(op.left_value, status);
		let saved_null: boolean | undefined;
		let saved_null_paths: Set<string> | undefined;
		if (left_check && !left_check.is_null_check) {
			const var_obj = status.values.findLast((v) => v.name === left_check.name);
			if (var_obj && var_obj.is_null) {
				saved_null = var_obj.is_null;
				var_obj.is_null = false;
			}
			// Dotted bases (`o.inner != null && o.inner.value …`): the left
			// guard proves the path non-null for the right operand; the
			// narrowing is transient.
			saved_null_paths = status.null_paths;
			status.null_paths = new Set(status.null_paths ?? []);
			status.null_paths.delete(left_check.name);
		}

		// Short-circuit bounds: when the right operand is evaluated, the left
		// operand was TRUE, so its bounds hold for the right operand's check.
		// This lets `.at(i)` verify inside a condition like
		// `i < x_end && xs.at(i) == ys.at(j)` — the bounds from earlier `&&`
		// operands are applied left-to-right while checking later ones. The
		// facts are transient (they don't hold after the whole expression), so
		// a snapshot of every value's flow bounds is restored afterwards.
		const saved_bounds = snapshot_all_bounds(status);
		apply_bounds(op.left_value, status);
		const right_ok = check_node(op.right_value, status);
		restore_all_bounds(status, saved_bounds);
		if (!right_ok) return false;

		// Restore is_null after the condition (else branch shouldn't be narrowed)
		if (saved_null !== undefined && left_check) {
			const var_obj = status.values.findLast((v) => v.name === left_check.name);
			if (var_obj) var_obj.is_null = saved_null;
		}
		if (saved_null_paths !== undefined) {
			status.null_paths = saved_null_paths;
		}

		op.type = new Type("bool");
		return true;
	}

	if (op.op === ("||" as const)) {
		if (!check_node(op.left_value, status)) return false;

		// Short-circuit bounds: when the right operand of `||` is evaluated,
		// the left operand was FALSE, so its NEGATION holds (De Morgan per
		// comparison — see apply_negated_bounds). Transient, like the `&&`
		// case: restored after the right operand's check.
		const saved_bounds = snapshot_all_bounds(status);
		apply_negated_bounds(op.left_value, status);
		const right_ok = check_node(op.right_value, status);
		restore_all_bounds(status, saved_bounds);
		if (!right_ok) return false;

		op.type = new Type("bool");
		return true;
	}

	const is_equality = op.op === "==" || op.op === "!=";
	const is_null_coalesce = op.op === "??";
	const old_allow_null = status.allow_null_value;
	if (is_equality || is_null_coalesce) {
		status.allow_null_value = true;
	}

	// Tuple concatenation under a tuple-typed context (`var [int, string, int]
	// t = [1, "a"] + [2]`): the operands compose their own shapes — the left
	// is checked free of the expected type, and the expected type's TAIL (the
	// elements after the left's arity) becomes the right operand's
	// expectation, so a bare `[2]` infers a 1-tuple there.
	const concat_tuple_context = op.op === "+" && !!status.expected_type?.tuple_types?.length;
	const concat_expected = concat_tuple_context ? status.expected_type : undefined;
	if (concat_tuple_context) {
		const saved = status.expected_type;
		status.expected_type = undefined;
		const left_ok = check_node(op.left_value, status);
		status.expected_type = saved;
		if (!left_ok) {
			status.allow_null_value = old_allow_null;
			return false;
		}
	} else if (!check_node(op.left_value, status)) {
		status.allow_null_value = old_allow_null;
		return false;
	}

	// ERRORS_PLAN (`??` corner): `y.v ?? fb` — a field access whose BASE is a
	// flagged nullable (a `T?` struct/scalar local or param) types as the
	// FIELD type, so the coalesce would test the raw field bytes and hand
	// back garbage when the base is null (the base's own `_has` flag never
	// consulted; audit receipt: `var y = val_of(0); y.v ?? 0` on aarch64
	// prints field garbage, and the C build emits the struct value as the
	// condition). Rewrite the operand to the chain spelling's node shape
	// (`y?.v`) so both backends lower it through the chain `??` path — the
	// exact lowering the explicit spelling gets. Only pure field reads
	// rewrite (a call base would be re-read by the chain's hop tests; the
	// `?.` spelling hoists those into a temp instead, so spell those as
	// chains).
	if (is_null_coalesce) {
		rewrite_flagged_nullable_field_coalesce(op, status);
	}

	const left_type = type_from_value_node(op.left_value, status);

	// ERRORS_PLAN: `result !! fallback` — the result coalesce. The left must
	// be a `Result<T, E>` value (the `T ! E` mono or an explicit Result);
	// the right must be T (and becomes its expected type), and the result
	// is T. Consuming the Result discharges the checked rule by
	// construction.
	if (op.op === "!!") {
		const result_enum = status.enums.findLast((e) => e.name === left_type.name);
		const ok_case = result_enum?.cases.find((c) => c.name === "ok");
		if (result_enum?.template_name === "UnitResult") {
			// `out ! E` results have no success VALUE — there is nothing to
			// coalesce or fall back to.
			add_error(
				status,
				`a '!' unit result has no success value — discard it with 'var _ =' or propagate with '!'`,
				op.start,
			);
			status.allow_null_value = old_allow_null;
			return false;
		}
		if (result_enum?.template_name !== "Result" || !ok_case?.params[0]) {
			add_error(
				status,
				`'!!' needs a 'T ! E' result on the left — '${left_type.name || "value"}' is not a result type`,
				op.start,
			);
			status.allow_null_value = old_allow_null;
			return false;
		}
		const success_type = ok_case.params[0].type;
		const saved_expected = status.expected_type;
		status.expected_type = success_type;
		const right_ok = check_node(op.right_value, status);
		status.expected_type = saved_expected;
		if (!right_ok) {
			status.allow_null_value = old_allow_null;
			return false;
		}
		const fallback_type = type_from_value_node(op.right_value, status);
		if (mono_type_name(fallback_type) !== mono_type_name(success_type)) {
			add_error(
				status,
				`the '!!' fallback must be the result's success type ('${success_type.name}') — got '${fallback_type.name || "value"}'`,
				op.right_value.start,
			);
			status.allow_null_value = old_allow_null;
			return false;
		}
		const coalesced = new Type(
			success_type.name,
			success_type.is_static,
			success_type.is_array,
			success_type.length,
		);
		coalesced.type_args = success_type.type_args;
		coalesced.is_ref = success_type.is_ref;
		coalesced.is_nullable = success_type.is_nullable;
		op.type = coalesced;
		op.coalesce_ok_field = ok_case.params[0].name;
		status.allow_null_value = old_allow_null;
		return true;
	}

	const old_expected_type = status.expected_type;
	// Tuple concatenation: the right operand keeps its own shape — a tuple
	// literal RHS must infer its own element types, not be validated against
	// the left tuple's shape (`[1, "a"] + [2, true]` widens, not mismatches).
	// Under the tuple context above, the expected elements after the left's
	// arity are the right operand's expectation.
	let right_expected: Type | undefined = left_type;
	const left_elems = op.op === "+" ? tuple_element_types(left_type, status) : undefined;
	if (left_elems) {
		right_expected = undefined;
		if (concat_expected) {
			const tail = concat_expected.tuple_types!.slice(left_elems.length);
			if (tail.length) {
				right_expected = new Type("tuple");
				right_expected.tuple_types = tail;
			}
		}
	}
	status.expected_type = right_expected;
	const right_result = check_node(op.right_value, status);
	status.expected_type = old_expected_type;
	status.allow_null_value = old_allow_null;
	if (!right_result) {
		return false;
	}

	const right_type = type_from_value_node(op.right_value, status);

	// Tuple concatenation: `t1 + t2` builds a fresh tuple whose elements are
	// t1's followed by t2's (`[1, "a"] + [2, true]` is `[1, "a", 2, true]`, a
	// `[int, string, int, bool]`). Rewritten into the generated tuple struct
	// constructor over field reads, so construction, ownership, and codegen
	// reuse the ordinary tuple-literal pipeline unchanged.
	if (op.op === "+" && left_elems) {
		const right_elems = tuple_element_types(right_type, status);
		if (right_elems) {
			return rewrite_tuple_concat(op, left_elems, right_elems, status);
		}
	}

	// Check for custom operator on struct (including arrays, which use the Array struct)
	const custom_op = find_custom_operator(op, left_type, right_type, status);
	if (custom_op) {
		const func = custom_op.func;
		// For array types, preserve the element type in the result
		if (left_type.is_array && func.return_type.name === "Array") {
			op.type = new Type(left_type.name);
			op.type.is_array = true;
		} else {
			op.type = func.return_type;
		}
		// A string-valued operator (String's `+`/`*`, or any user operator
		// returning string) is a CALL result — the backends hand every string
		// return a FRESH heap buffer (C strdup's it; aarch64 normalizes at
		// the call/return boundary). `func.return_type` is a SHARED signature
		// Type, and its `is_static` can be inherited from the callee body's
		// literals — carrying it made ownership decisions order-dependent (a
		// concat initializer that read `static` lost its scope-exit free
		// depending on what else had been checked). Clone with the static bit
		// cleared.
		if (op.type.name === "string") {
			const operator_result = new Type(op.type.name, false, op.type.is_array, op.type.length);
			operator_result.type_args = op.type.type_args;
			operator_result.is_ref = op.type.is_ref;
			op.type = operator_result;
		}
		const struct_name =
			custom_op.mono_struct_name || (left_type.is_array ? "Array" : left_type.name);
		const func_name = operator_to_func_name(op.op) || func.name;
		const struct_node = status.structs.find((s) => s.name === struct_name);
		op.operator_func = {
			struct_name,
			func_name: func.name,
			mangled_name:
				struct_node && is_overloaded(struct_node, func_name)
					? mangled_label(func, struct_name)
					: undefined,
			invert: custom_op.invert,
		};

		// USER-DECLARED OPERATOR CONTRACTS: a constraint on the operator
		// function's parameter (`#op_mod = (self, int other: other != 0, out
		// int)`) verifies at the operation site — the same machinery a call
		// site runs for `fn = (int i: i < self.length)`. Previously the
		// constraint was silently ignored at `a % b` shapes. Provable-only:
		// an unverifiable argument is the author's documented precondition.
		// The declared constraint still does its main work INSIDE the body:
		// its facts apply_bounds onto the parameter, discharging the body's
		// own operator obligations (`#op_div = (self, Vec2 other: other.x !=
		// 0, …)` makes `self.x / other.x` verify).
		verify_operator_param_constraint(func, op, left_type, right_type, status, false);

		// Propagate array length for + and * operations
		if (left_type.is_array && op.type.is_array) {
			const left_len = left_type.length ? parseInt((left_type.length as any).value || "0") : 0;
			const right_val = value_from_value_node(op.right_value);

			if (op.op === "+" && right_type.is_array) {
				const right_len = right_type.length ? parseInt((right_type.length as any).value || "0") : 0;
				op.type.length = new ValueNode(-1, (left_len + right_len).toString(), new Type("int"));
			} else if (op.op === "*" && right_type.name === "int" && /^(\+|-)*\d+$/.test(right_val)) {
				const multiplier = parseInt(right_val);
				op.type.length = new ValueNode(-1, (left_len * multiplier).toString(), new Type("int"));
			}
		}

		// String concat is a read-only consumer of both operands (it copies
		// them into a fresh buffer), so a borrow-position `to_string()` operand
		// needs no owned copy (STRING_PLAN tranche 3). No mutation scan is
		// required here — concat never writes through its operands.
		if (op.op === "+" && op.type.name === "string") {
			maybe_mark_borrow_to_string_operand(op.left_value, status);
			maybe_mark_borrow_to_string_operand(op.right_value, status);
		}

		return true;
	}

	// If left operand is a non-simple struct and no custom operator was found, it's an error
	// But ref and nullable types can use == and != (comparing pointers or checking null)
	const struct_name = left_type.is_array ? "Array" : left_type.name;
	if (
		status.structs.find((s) => s.name === struct_name && !s.is_simple_type) &&
		!(left_type.is_ref || left_type.is_nullable)
	) {
		add_error(status, `No operator ${op.op as string} defined for type ${struct_name}`, op.start);
		return false;
	}

	check_type_and_value_match(
		left_type,
		right_type,
		value_from_value_node(op.right_value),
		status,
		op.right_value.start,
		"operation",
	);

	// BUILT-IN SCALAR OPERATOR CONTRACTS: a simple (built-in) type's operator
	// function declaration carries the contract for the native operator
	// (`int`'s `#op_div = (self, int divisor: divisor != 0, out int)` in the
	// System library). find_custom_operator never dispatches simple types —
	// the backends lower scalar arithmetic natively, so the declaration's
	// body is never called by the operator — but its parameter contract is
	// verified here, STRICTLY: the language's own types have total contracts
	// (user operator functions are checked only when provable). This is the
	// same machinery, not a per-operator rule: any contract declared on a
	// built-in type's operator function applies.
	const left_is_simple =
		!left_type.is_array &&
		!left_type.is_ref &&
		!left_type.is_nullable &&
		get_built_in_type(left_type.name)?.kind !== "string"
			? status.structs.find((s) => s.name === left_type.name && s.is_simple_type)
			: undefined;
	if (left_is_simple) {
		const op_func_name = operator_to_func_name(op.op);
		const builtin_decl = op_func_name
			? left_is_simple.functions.find((f) => f.name === op_func_name)
			: undefined;
		if (builtin_decl?.params.some((p) => !p.is_self_param && p.constraint)) {
			verify_operator_param_constraint(builtin_decl, op, left_type, right_type, status, true);
		}
	}

	// `==`/`!=` on type-parameter-typed operands inside a generic body (e.g.
	// `load_T(idx) == key` in `Map<TK, TV>`). The concrete type isn't known
	// until monomorphization, so we can't resolve the custom operator now.
	// Mark it deferred — the build backends resolve it against the concrete
	// type (custom `eq`/`ne` call if the struct defines one, else builtin).
	if ((op.op === "==" || op.op === "!=") && left_type.name) {
		const left_is_unresolved = !status.structs.find((s) => s.name === left_type.name);
		if (left_is_unresolved) {
			op.operator_func = {
				struct_name: left_type.name,
				func_name: op.op === "==" ? "eq" : "ne",
				deferred: true,
			};
		}
	}

	// HACK: this needs to come from operator funcs for each operator and type combination
	switch (op.op) {
		case "+":
		case "-":
		case "*":
		case "/":
		case "%":
		case "<<":
		case ">>":
		case "&":
		case "|":
		case "^": {
			op.type = left_type;
			// A string concat/repeat (`"a" + b`, `s * n`) allocates a FRESH
			// heap buffer — never static storage. The shared left_type above
			// would carry a literal operand's `is_static` (and later checks
			// mutate that SHARED Type instance), making ownership decisions
			// order-dependent: a concat initializer that inherited `static`
			// from a literal lost its scope-exit free (a leak) when nothing
			// later cleared the flag. Clone instead of mutating the operand's
			// type, and clear the static bit.
			if (op.type.name === "string") {
				const concat_type = new Type(op.type.name, false, op.type.is_array, op.type.length);
				concat_type.type_args = op.type.type_args;
				concat_type.is_ref = op.type.is_ref;
				op.type = concat_type;
			}
			break;
		}
		case "==":
		case "!=":
		case ">":
		case ">=":
		case "<":
		case "<=": {
			op.type = new Type("bool");
			break;
		}
		case "??": {
			// `??` coalesces NULL: a non-nullable left has no null to replace,
			// so the fallback is dead code — and the generic lowering tests
			// the left's raw bytes as the condition (a struct left is a C
			// compile error; a string left reads past its meaning). Every
			// accepted left carries nullness: the in-band fat zero (a
			// `string?`), the `_has` companion (scalars, inline structs,
			// simple enums/bitsets), the in-band pointer (func/class), or a
			// nullable chain (whose hop tests consume the nullness here).
			// Mirrors the `?.` rule ("needs a nullable target"); a plain
			// field read on a nullable base is rewritten to the chain shape
			// above, so it arrives here nullable too. A chain whose final
			// steps are plain `.` reads stamps the WRAPPER as the member
			// type (`mk(7)?.inner.value` types `int`), so the chain test is
			// structural, not type-driven.
			if (!left_type.is_nullable && !has_null_chain(op.left_value)) {
				add_error(
					status,
					`'??' needs a nullable left — '${type_name(left_type)}' is not nullable; the fallback could never run`,
					op.start,
				);
				return false;
			}
			// A nullable CHAIN as the fallback needs the (value, flag) carrier
			// the fallback slot does not have: the coalesce would drop the
			// chain's nullness on the taken path. Spell the coalesce on the
			// chain itself (`x ?? (b?.c ?? fb)`).
			if (has_null_chain(op.right_value)) {
				add_error(
					status,
					`a nullable chain cannot be a '??' fallback — coalesce the chain first ('x ?? (b?.c ?? fb)')`,
					op.start,
				);
				return false;
			}
			const result_type = new Type(
				left_type.name,
				left_type.is_static,
				left_type.is_array,
				left_type.length,
			);
			result_type.type_args = left_type.type_args;
			result_type.is_ref = left_type.is_ref;
			op.type = result_type;
			break;
		}
		default: {
			add_error(status, `Unknown operator: ${op.op as string}`, op.start);
			return false;
		}
	}

	return true;
}

function find_custom_operator(
	op: OperationNode,
	left_type: Type,
	right_type: Type,
	status: CheckStatus,
): { func: FunctionNode; mono_struct_name?: string; invert?: boolean } | undefined {
	// `x == null` / `x != null` is a null test, never user-defined equality.
	// Routing it through `#op_eq` would type-check the `null` literal against
	// the operand type (`string.#op_eq(string other)`) and reject it, so a
	// `string?` could never be compared to null. Fall through to the built-in
	// nullable comparison instead.
	if ((op.op === "==" || op.op === "!=") && is_null_literal(op)) {
		return undefined;
	}

	// For array types, look up operators on the Array struct
	const struct_name = left_type.is_array ? "Array" : left_type.name;
	if (!struct_name) {
		return undefined;
	}

	let struct = status.structs.find((s) => s.name === struct_name);
	if (!struct) {
		return undefined;
	}
	// Natively-lowered built-in scalars (everything but `string`, whose
	// operators are real library functions) carry their operator
	// declarations as CONTRACT SIGNATURES (`int`'s `#op_div = (self, int
	// divisor: divisor != 0, …)`): the backends lower scalar arithmetic
	// natively, so an operator on such a type must never dispatch as a
	// function call. check_operation_node verifies the declaration's
	// constraint separately.
	const builtin_info = get_built_in_type(struct.name);
	if (struct.is_simple_type && builtin_info?.kind !== "string") {
		return undefined;
	}

	const func_name = operator_to_func_name(op.op);
	if (!func_name) {
		return undefined;
	}

	// For generic Array struct with arrays, monomorphize for the element type
	let mono_struct_name: string | undefined;
	if (struct.type_params.length > 0 && left_type.is_array) {
		const elem_type = new Type(left_type.name);
		const mono = monomorphize(struct, [elem_type], status);
		if (mono) {
			mono_struct_name = mono.name;
			struct = mono;
		}
	}

	let func = find_function_by_params(struct.functions, func_name, [right_type]);
	let invert = false;
	// Equality operators are duals: if the struct defines `eq` but not `ne`
	// (or vice versa), the missing one is derived as the logical negation of
	// the present one. So writing only `#op_eq` gives you both `==` and `!=`.
	if (!func && (op.op === "==" || op.op === "!=")) {
		const dual_name = op.op === "==" ? "ne" : "eq";
		const dual = find_function_by_params(struct.functions, dual_name, [right_type]);
		if (dual) {
			func = dual;
			invert = true;
		}
	}
	if (!func) {
		return undefined;
	}

	// Validate that the function has a non-self parameter matching the right operand type
	const non_self_params = func.params.filter((p) => !p.is_self_param);
	if (non_self_params.length !== 1) {
		add_error(
			status,
			`Operator function ${func_name} must take exactly one parameter (plus self)`,
			op.start,
		);
		return undefined;
	}

	const other_param = non_self_params[0];
	// For array operators, Array struct parameters accept any array type
	const param_type = other_param.type;
	if (param_type.name === "Array" && !param_type.is_array && right_type.is_array) {
		// Array struct parameter matches any array type
	} else {
		check_type_and_value_match(
			param_type,
			right_type,
			value_from_value_node(op.right_value),
			status,
			op.right_value.start,
			"param",
		);
	}

	return { func, mono_struct_name, invert };
}

/** Is either side of `op` the literal `null`? */
function is_null_literal(op: OperationNode): boolean {
	const left = op.left_value;
	const right = op.right_value;
	if (right.node_type === "value" && (right as ValueNode).value === "null") return true;
	if (left.node_type === "value" && (left as ValueNode).value === "null") return true;
	return false;
}

function operator_to_func_name(op: string): string | undefined {
	switch (op) {
		case "+":
			return "add";
		case "-":
			return "sub";
		case "*":
			return "mul";
		case "/":
			return "div";
		case "%":
			return "mod";
		case "==":
			return "eq";
		case "!=":
			return "ne";
		default:
			return undefined;
	}
}

/**
 * Verify the declared parameter contract of an operator function against the
 * operation's right operand (`a OP b`): the non-self parameter is bound to
 * `b` — carrying its declaration facts (const value, ranges, bounds, non-zero
 * guards) — and `self` to the left operand, so a constraint like
 * `divisor != 0` or `other.x != 0` evaluates with the usual machinery.
 *
 * `strict` decides what an UNVERIFIABLE constraint means: `true` (built-in
 * scalar operator functions — the language's own total contracts) reports
 * `Parameter constraint cannot be verified` unless inside a System-library
 * method (the `.at` carve-out); `false` (user operator functions) treats the
 * constraint as a documented precondition and only reports PROVABLE
 * violations. A provable violation always errors.
 */
function verify_operator_param_constraint(
	func: FunctionNode,
	op: OperationNode,
	left_type: Type,
	right_type: Type,
	status: CheckStatus,
	strict: boolean,
): void {
	const other_param = func.params.find((p) => !p.is_self_param && p.constraint);
	if (!other_param?.constraint) return;
	const saved_values_length = status.values.length;
	const arg_name = value_from_value_node(op.right_value);
	const arg_decl = arg_name ? status.values.findLast((v) => v.name === arg_name) : undefined;
	status.values.push({
		declaration: "const",
		name: other_param.name,
		type: right_type,
		is_set: true,
		const_value:
			arg_decl?.const_value ??
			(op.right_value.node_type === "value" &&
			/^[+-]?\d+$/.test((op.right_value as ValueNode).value)
				? parseInt((op.right_value as ValueNode).value, 10)
				: undefined),
		range_lower: arg_decl?.range_lower,
		range_upper: arg_decl?.range_upper,
		upper_bound_exprs: arg_decl?.upper_bound_exprs,
		lower_bound_exprs: arg_decl?.lower_bound_exprs,
		upper_bound_inclusive_exprs: arg_decl?.upper_bound_inclusive_exprs,
		lower_bound_inclusive_exprs: arg_decl?.lower_bound_inclusive_exprs,
		nonzero_exprs: arg_decl?.nonzero_exprs?.map(() => other_param.name),
		alias_of:
			!arg_name && op.right_value.node_type === "access"
				? expr_to_string(op.right_value, status)
				: undefined,
	});
	// Push self so the constraint can reference self fields.
	const self_path = expr_to_string(op.left_value, status);
	if (self_path) {
		// A field-path receiver (`f.ships`): the base's path facts are keyed
		// by the caller-side path (`f.ships.length`); the substituted
		// constraint asks for `self.length`, so the synthetic self must see
		// them under its OWN path — same rename as check_function_call's
		// synthetic self. Without it, `f.ships.at(0)` can never discharge
		// its contract against the guard facts.
		const self_base = status.values.findLast((v) => v.name === self_path.split(".")[0]);
		let synthetic_path_bounds = self_base?.path_bounds;
		if (synthetic_path_bounds && self_path.includes(".")) {
			const prefix = `${self_path}.`;
			const renamed = new Map<string, import("./StackValue.ts").PathBounds>();
			for (const [key, entry] of synthetic_path_bounds) {
				if (key === self_path) renamed.set("self", entry);
				else if (key.startsWith(prefix)) renamed.set(`self.${key.slice(prefix.length)}`, entry);
			}
			synthetic_path_bounds = renamed.size > 0 ? renamed : undefined;
		}
		status.values.push({
			declaration: "const",
			name: "self",
			type: left_type,
			is_set: true,
			alias_of: self_path,
			path_bounds: synthetic_path_bounds,
		});
	}
	const satisfied = evaluate_const_condition(other_param.constraint, status);
	status.values.length = saved_values_length;
	const constraint_source = expression_to_source(other_param.constraint);
	const suffix = constraint_source ? `\n  ${constraint_source}` : "";
	if (satisfied === false || satisfied === "unsafe") {
		add_error(status, `Parameter constraint not satisfied: ${other_param.name}${suffix}`, op.start);
	} else if (strict && satisfied === undefined && !is_inside_core_method(status)) {
		add_error(
			status,
			`Parameter constraint cannot be verified: ${other_param.name}${suffix}`,
			op.start,
		);
	}
}

/**
 * The element types of a tuple-typed value: either the tuple shape carried on
 * the type, or the fields of the materialized generated tuple struct.
 * Undefined for non-tuple types.
 */
function tuple_element_types(t: Type, status: CheckStatus): Type[] | undefined {
	if (t.tuple_types?.length) return t.tuple_types;
	if (t.name?.startsWith("_Tuple_")) {
		const struct = status.structs.findLast((s) => s.name === t.name && !s.is_simple_type);
		if (struct) return struct.fields.map((f) => f.type);
	}
	return undefined;
}

/**
 * Whether a tuple-concat element must be `.copy()`'d out of its source field:
 * anything whose byte-copy would alias heap the source still owns (mv
 * strings, owning structs/containers). Mirrors the ownership gates of the
 * tuple-literal element pass (check_tuple_element_ownership).
 */
function element_needs_copy(t: Type, status: CheckStatus): boolean {
	if (t.name === "string" && !t.is_view && !t.is_array) return true;
	return is_owning_struct_type(t, status);
}

/**
 * Rewrite `t1 + t2` in place into a constructor call over field reads:
 * `_Tuple_(t1 fields + t2 fields)(t1._0, ..., t2._0, ...)`. Non-variable
 * operands (tuple literals, call results) are hoisted to temps first so
 * every field read targets an lvalue; struct-typed field reads are hoisted
 * again by the final pass, exactly as tuple-literal elements are.
 */
function rewrite_tuple_concat(
	op: OperationNode,
	left_elems: Type[],
	right_elems: Type[],
	status: CheckStatus,
): boolean {
	const elem_types = [...left_elems, ...right_elems];
	const struct_name = tuple_struct_name(elem_types);
	get_or_create_tuple_struct(elem_types, status);

	const constructor = new FunctionCallNode(op.start, struct_name);
	constructor.params = [op.left_value, op.right_value];
	hoist_struct_params(constructor, status);
	const [left_target, right_target] = constructor.params;

	const params: BaseNode[] = [];
	let result = true;
	const old_expected = status.expected_type;
	const operands: [BaseNode, Type[]][] = [
		[left_target, left_elems],
		[right_target, right_elems],
	];
	for (const [target, elems] of operands) {
		for (let i = 0; i < elems.length; i++) {
			let arg: BaseNode = new AccessNode(
				op.start,
				target,
				new AccessFieldNode(op.start, `_${i}`, elems[i]),
			);
			if (element_needs_copy(elems[i], status)) {
				const copy_call = new AccessNode(
					op.start,
					arg,
					new AccessFunctionCallNode(op.start, "copy", elems[i]),
				);
				status.expected_type = elems[i];
				if (!check_node(copy_call, status)) result = false;
				// The copy result is hoisted to a named const (not re-checked —
				// the build reads it like any variable): a call-result string
				// marshalled straight into an `#init` argument list loses its
				// hidden length half (the args shift after it — the
				// pre-existing rvalue-arg gap hoist_struct_params exists for).
				// A named local carries both halves and marshals correctly.
				const decl_name = `_param_${status.var_name_counter.value++}`;
				status.allocations.push(
					new DeclarationNode(op.start, "private", "const", decl_name, elems[i], copy_call),
				);
				arg = new ValueNode(op.start, decl_name, elems[i]);
				params.push(arg);
				continue;
			}
			status.expected_type = elems[i];
			if (!check_node(arg, status)) result = false;
			params.push(arg);
		}
	}
	status.expected_type = old_expected;

	constructor.params = params;
	hoist_struct_params(constructor, status);
	const new_type = new Type(struct_name);
	new_type.tuple_types = elem_types;
	constructor.type = new_type;
	replace_with_call(op, constructor);
	return result;
}

/**
 * Replace `target` (an OperationNode) with `source` (a FunctionCallNode) in
 * place, so any references held by parents observe the new node type.
 */
function replace_with_call(target: OperationNode, source: FunctionCallNode): void {
	(target as any).node_type = source.node_type;
	(target as any).name = source.name;
	(target as any).type = source.type;
	(target as any).params = source.params;
	(target as any).is_static = source.is_static;
	(target as any).type_args = source.type_args;
	(target as any).ref_param_indices = source.ref_param_indices;
	(target as any).move_param_indices = source.move_param_indices;
	(target as any).swap_params = source.swap_params;
	(target as any).variadic_param_name = source.variadic_param_name;
	(target as any).variadic_param_index = source.variadic_param_index;
	(target as any).resolved_function = source.resolved_function;
}

/**
 * Rewrite `y.f1.f2 ?? fb` — a pure field chain rooted at a FLAGGED nullable
 * base (a `T?` struct/scalar binding; string/func null is in-band and reads
 * its zero, so those keep the plain form) — into the chain spelling's node
 * shape (`y?.f1.f2`), reusing the checked access nodes so every stamp rides.
 * The backends then take the chain `??` path: hop tests consult the base's
 * own `_has` flag instead of testing the raw field bytes, which is the
 * documented sound spelling. No-ops on every other shape (a non-nullable or
 * in-band base, a method-call step, a call base — the chain's hop tests
 * re-read the base, and a call would run twice; spell those `f()?.v`, whose
 * checker hoists the call into a temp).
 */
function rewrite_flagged_nullable_field_coalesce(op: OperationNode, status: CheckStatus): void {
	let cursor: BaseNode = op.left_value;
	while (cursor.node_type === "grouped") {
		cursor = (cursor as unknown as { value: BaseNode }).value;
	}
	const steps: AccessFieldNode[] = [];
	while (
		cursor.node_type === "access" &&
		(cursor as AccessNode).access.node_type === "access_field"
	) {
		const an = cursor as AccessNode;
		steps.unshift(an.access as AccessFieldNode);
		cursor = an.target;
	}
	while (cursor.node_type === "grouped") {
		cursor = (cursor as unknown as { value: BaseNode }).value;
	}
	if (!steps.length) return;
	// The base must be a re-readable path (the flatten's hop tests re-read
	// it): a value binding, or a pure field chain onto one.
	const readable = (n: BaseNode): boolean =>
		n.node_type === "value" ||
		(n.node_type === "access" &&
			(n as AccessNode).access.node_type === "access_field" &&
			readable((n as AccessNode).target));
	if (!readable(cursor)) return;
	const base_type = type_from_value_node(cursor, status);
	if (!is_nullable_flagged_type(base_type, status)) return;
	// The chain result is the final member's type made nullable — the shape
	// check_null_access_node stamps for the explicit `?.` spelling, so the
	// coalesce's typing (`??` yields the member type, null stripped) is
	// unchanged.
	const na = new NullAccessNode(op.left_value.start, cursor, steps[0]);
	let value: BaseNode = na;
	for (let i = 1; i < steps.length; i++) {
		value = new AccessNode(steps[i].start, value, steps[i]);
	}
	const final_field = steps[steps.length - 1];
	if (!final_field.type?.name) return;
	const chain_t = new Type(
		final_field.type.name,
		final_field.type.is_static,
		final_field.type.is_array,
		final_field.type.length,
	);
	chain_t.type_args = final_field.type.type_args;
	chain_t.is_ref = final_field.type.is_ref;
	chain_t.is_nullable = true;
	na.type = chain_t;
	op.left_value = value;
}
