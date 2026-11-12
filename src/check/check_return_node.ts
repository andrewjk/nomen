import add_error from "../add_error.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { borrow_depth_of, borrow_owner_of } from "./utils/borrow.ts";
import { move_closure_source } from "./utils/captures.ts";
import check_func_argument_signature from "./utils/check_func_argument_signature.ts";
import check_merged_missing_return from "./utils/check_merged_missing_return.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import {
	enforce_case_payload_ownership,
	hoist_case_string_arg_temp,
	stamp_in_place_enum_payloads,
} from "./utils/enum_mono.ts";
import {
	borrowed_param_transfer_error,
	is_owning_struct_type_requiring_move,
} from "./utils/ownership.ts";
import synthesize_lambda_name from "./utils/synthesize_lambda_name.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";
import {
	ctor_call_view_borrow,
	type_can_carry_view_borrow,
	view_borrows_root_at_self,
	struct_has_view_fields,
} from "./utils/view_fields.ts";

function is_class_type(type_name: string, status: CheckStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && s.is_class);
}

function get_inner_value_node(node: import("../nodes/BaseNode.ts").default): ValueNode | null {
	if (node.node_type === "value") return node as ValueNode;
	if (node.node_type === "grouped") return get_inner_value_node((node as any).value);
	return null;
}

export default function check_return_node(ret: ReturnNode, status: CheckStatus) {
	let func: ReturningNode | null = null;
	for (let i = status.stack.length - 1; i >= 0; i--) {
		if (status.stack[i].node_type === "func") {
			func = status.stack[i] as ReturningNode;
			break;
		}
	}

	if (!ret.value) {
		// ERRORS_PLAN: `return` in a unit-result function (`out ! E`) is
		// SUCCESS — the builder constructs the ok case.
		const bare_fn = func as FunctionNode | null;
		if (bare_fn?.returns_result && bare_fn.unit_result && bare_fn.return_type.name) {
			ret.type = bare_fn.return_type;
			return;
		}
		if (func && !func.return_type.name) {
			func.return_type = new Type("void");
		}
		ret.type = new Type("void");
		return;
	}

	// ERRORS_PLAN: bare-return lifting for the `T ! E` result form (single)
	// and the composed `T ! E1, E2` set. Shorthand cases resolve against the
	// ERROR SET first when they name no Result case (`return .notfound` is
	// `Result.fail(.notfound)`; in a composed set the single member declaring
	// the case supplies the tag, and a case declared by several members is
	// ambiguous). The pre-wrap exploits the shorthand-call branch's
	// per-argument expected type recursively: checking `.fail(.LoadError(
	// <shorthand>))` resolves each layer against its payload type with zero
	// new resolution machinery. Non-shorthand values lift by their checked
	// type — the post-check wrap below.
	const fn = func as FunctionNode | null;
	const fn_members = fn?.result_error_types ?? [];
	const fn_composed = fn_members.length > 1;
	// `.case` shorthand and `.case(args)` payload shorthand both arrive as a
	// dotted head — a bare ValueNode or a FunctionCallNode's name.
	const shorthand_case = (node: BaseNode): { name: string; start: number } | undefined => {
		const head =
			node.node_type === "value"
				? (node as ValueNode).value
				: node.node_type === "func_call"
					? (node as FunctionCallNode).name
					: "";
		if (
			typeof head === "string" &&
			head.startsWith(".") &&
			head.length > 1 &&
			!head.startsWith("..")
		) {
			return { name: head.substring(1), start: node.start };
		}
		return undefined;
	};
	const shorthand = shorthand_case(ret.value);
	if (fn?.returns_result && fn.return_type.name && fn.return_type.name !== "?" && shorthand) {
		const case_name = shorthand.name;
		const result_enum = status.enums.findLast((e) => e.name === fn.return_type.name);
		const is_result_like =
			result_enum?.template_name === "Result" || result_enum?.template_name === "UnitResult";
		const on_result = !!result_enum?.cases.some((c) => c.name === case_name);
		if (is_result_like && !on_result) {
			const owners = fn_members.filter((m) =>
				status.enums.findLast((e) => e.name === m.name)?.cases.some((c) => c.name === case_name),
			);
			// The SUCCESS side may itself be an enum (an anonymous success
			// enum, `out [.ok, .redirect] ! E`): a shorthand naming one of its
			// cases lifts through `.ok(...)` the same way.
			const ok_case = result_enum.cases.find((c) => c.name === "ok");
			const ok_enum = ok_case?.params[0]
				? status.enums.findLast((e) => e.name === ok_case.params[0].type.name)
				: undefined;
			const on_ok = !!ok_enum?.cases.some((c) => c.name === case_name);
			if (owners.length > 1) {
				add_error(
					status,
					`case '.${case_name}' is ambiguous in the error set (${owners.map((o) => o.name).join(", ")}) — qualify the origin (\`${owners[0].name}.${case_name}\`)`,
					shorthand.start,
				);
			}
			if (owners.length >= 1) {
				const fail_value = fn_composed
					? new FunctionCallNode(shorthand.start, `.${owners[0].name}`, undefined, [ret.value])
					: ret.value;
				ret.value = new FunctionCallNode(shorthand.start, ".fail", undefined, [fail_value]);
			} else if (on_ok) {
				ret.value = new FunctionCallNode(shorthand.start, ".ok", undefined, [ret.value]);
			}
		}
	}

	// Views are second-class across calls (SPEC Slicing): a struct with
	// `view` fields is a scope-local bundle — its bytes borrow from this
	// frame's storage (or the receiver's), and the caller's binding cannot
	// be pinned to those sources across the boundary. No function or method
	// may return one, self-rooted included (a re-rooted bundle is exactly
	// what the caller cannot track). `out view T` returns stay allowed: a
	// plain view is re-rooted at the call-site receiver by convention.
	// Skipped when the DECLARATION was already rejected
	// (check_function_node) — the signature error is the one that counts.
	if (
		func?.return_type &&
		!func.return_type.is_view &&
		func.return_type.name &&
		struct_has_view_fields(func.return_type.name, status) &&
		!(func as { view_bundle_return_rejected?: boolean }).view_bundle_return_rejected
	) {
		add_error(
			status,
			`cannot return a '${func.return_type.name}' — structs with 'view' fields are scope-local; return the fields (the views) instead`,
			ret.value.start,
		);
	}

	const old_expected_type = status.expected_type;
	if (func?.return_type?.name && func.return_type.name !== "?") {
		status.expected_type = func.return_type;
	}
	// A nullable return type (`out T?`) accepts a may-be-null value — the
	// null-ness travels with the value (both backends carry a companion
	// `_has` flag for nullable struct/scalar returns). Without this, `return x`
	// on a `T?` parameter errors with "Variable 'x' may be null" even though
	// the return type is exactly as nullable as the value.
	const old_allow_null = status.allow_null_value;
	if (func?.return_type?.is_nullable) {
		status.allow_null_value = true;
	}

	if (!check_node(ret.value, status)) {
		status.expected_type = old_expected_type;
		status.allow_null_value = old_allow_null;
		return;
	}
	status.expected_type = old_expected_type;
	status.allow_null_value = old_allow_null;

	ret.type = type_from_value_node(ret.value, status);

	// A bare field read of an OWNING-typed field (`return h.c`) is a COPY of
	// the field's value — the returned instance would share the field's owned
	// state (double destroy). Same rule as the declaration side: transfer it
	// with `mv ... swap <replacement>` instead.
	if (
		ret.value.node_type === "access" &&
		(ret.value as AccessNode).access.node_type === "access_field"
	) {
		const af = (ret.value as AccessNode).access as AccessFieldNode;
		const base_target = (ret.value as AccessNode).target;
		const base_type = type_from_value_node(base_target, status);
		// The rule is about copying out of a NAMED binding's storage. A
		// hoisted compiler temp (`_recv_N` receiver hoist) is not one: its
		// lifetime is the statement, and its field reads ride the
		// accessor/view conventions (e.g. a `view string` return of
		// `xs.at(i).text`).
		const base_name = base_target.node_type === "value" ? (base_target as ValueNode).value : "";
		const base_is_binding = !!base_name && status.values.some((v) => v.name === base_name);
		if (base_type.name && base_is_binding) {
			const owner_struct = status.structs.findLast(
				(s) => s.name === mono_type_name(base_type) && !s.is_generic,
			);
			const field = owner_struct?.fields.find((f) => f.name === af.name);
			if (
				field?.type.name &&
				!field.type.is_array &&
				!field.type.is_view &&
				!field.type.is_ref &&
				(is_class_type(field.type.name, status) ||
					is_owning_struct_type_requiring_move(new Type(mono_type_name(field.type)), status))
			) {
				add_error(
					status,
					`cannot copy '${field.type.name}' out of field '${af.name}' by value — it owns heap resources; use 'mv ... swap <replacement>'${field.type.name === "string" ? ", or .copy() for a deep copy" : ""}`,
					ret.value.start,
				);
			}
		}
	}

	if (func && ret.type && is_class_type(ret.type.name, status)) {
		const value_node = get_inner_value_node(ret.value);
		if (value_node) {
			const param = (func as import("../nodes/FunctionNode.ts").default).params.find(
				(p) => p.name === value_node.value,
			);
			if (param && is_class_type(param.type.name, status) && !param.is_moved) {
				add_error(
					status,
					`Cannot return heap-instance parameter '${param.name}' without 'mv' — would create shared ownership`,
					ret.value.start,
				);
			}
		}
	}
	// A `ref` STRUCT param returned by value is an implicit borrow escape: the
	// callee received the caller's storage by address, and a by-value return
	// would copy the instance's owned state out from under it. Transfer with
	// `mv` (the value-struct param form) or return a field's VALUE instead.
	if (func && ret.type.name) {
		const value_node = get_inner_value_node(ret.value);
		if (value_node?.node_type === "value" && !value_node.is_moved) {
			const param = (func as import("../nodes/FunctionNode.ts").default).params.find(
				(p) => p.name === value_node.value,
			);
			const param_struct =
				param && !param.is_self_param
					? status.structs.find(
							(s) => s.name === param.type.name && !s.is_simple_type && !s.is_class,
						)
					: undefined;
			if (param && !param.is_self_param && (param.is_ref || param.type.is_ref) && param_struct) {
				add_error(
					status,
					`cannot return '${param.name}' — a 'ref' borrow escapes implicitly; declare the parameter 'mv' to transfer it`,
					ret.value.start,
				);
			}
		}
	}

	// A bare owning-mv-struct parameter returned by value (with `mv` or
	// without) transfers ownership the caller still holds: the call boundary
	// aliased the caller's storage, so the returned copy and the caller's
	// local would both destroy the same heap. Same rule family as the
	// 'ref'-param return above — declare the parameter `mv` (the call site
	// then transfers with `mv` and the donor is invalidated) or return a
	// `.copy()`. A `view`/`ref` return re-roots a borrow instead of
	// transferring, so it is exempt.
	if (func && ret.type.name && !func.return_type.is_view && !func.return_type.is_ref) {
		const value_node = get_inner_value_node(ret.value);
		if (value_node?.node_type === "value") {
			const param = (func as import("../nodes/FunctionNode.ts").default).params.find(
				(p) => p.name === value_node.value,
			);
			const transfer_error = borrowed_param_transfer_error(param, status);
			if (transfer_error) {
				add_error(status, transfer_error, ret.value.start);
			}
		}
	}

	// A borrowed class reference must not be returned IMPLICITLY — it would
	// escape the function scope and outlive the instance it points into. Use
	// `mv` to make the escape explicit (for a borrow, the caller receives a
	// non-mv reference — classified at the call site by the method-borrow
	// rules) or `mv … swap …` to transfer a replacement in. The other
	// exception is a `view T` return that borrows from `self` (the receiver):
	// a slice method hands back a non-mv borrow that the caller re-roots
	// at the call-site receiver (see borrow_depth_of), so returning it is
	// sound. A view borrowing from a non-self param/local still escapes and is
	// rejected.
	if (func && borrow_depth_of(ret.value, status) !== undefined) {
		const ret_value_name = value_from_value_node(ret.value);
		const sv =
			ret_value_name !== undefined
				? status.values.findLast((v) => v.name === ret_value_name)
				: undefined;
		if (sv?.has_view_borrows) {
			// A struct whose `view T` fields hold borrows: its bytes carry
			// slices of someone else's storage, and `mv` cannot transfer that
			// ownership (there is none). Returning is sound only when every
			// field borrow roots at `self` — the same re-rooting convention as
			// the direct-view case above (a method handing its receiver's
			// slices back to the caller).
			if (!view_borrows_root_at_self(sv)) {
				add_error(
					status,
					`cannot return '${ret.type.name}' — its 'view' field(s) borrow from this scope`,
					ret.value.start,
				);
			}
		} else {
			const borrow_owner = borrow_owner_of(ret.value, status);
			const safe_view_from_self = !!func.return_type?.is_view && borrow_owner === "self";
			// A CLASS/TRAIT borrow rooted at `self` may be returned too: the
			// call site re-roots the result at the receiver argument (the same
			// convention as `view T` returns), so the borrow's lifetime is the
			// caller's use of its own object — exactly like `list.at(i)`
			// assigned to a local. This is what makes accessor methods sound:
			// `pub func node = (self, int i, out Node) {
			//      return self.nodes.at_or_panic(i) }`.
			const safe_class_borrow_from_self = !func.return_type?.is_view && borrow_owner === "self";
			const explicit_mov = !!get_inner_value_node(ret.value)?.is_moved;
			if (!safe_view_from_self && !safe_class_borrow_from_self && !explicit_mov) {
				add_error(
					status,
					`cannot return a borrowed reference — use 'mv' (with swap) to transfer ownership`,
					ret.value.start,
				);
			}
		}
	} else if (func && ret.value.node_type === "func_call") {
		// A CONSTRUCTOR call returned directly (`return Line(doc.slice(…))`):
		// the fresh value's `view T` arguments borrow from this frame's
		// storage. Sound only when every argument's borrow roots at `self`
		// (re-rooted at the call-site receiver); anything else dangles the
		// moment the function returns. Plain calls are checked too, but only
		// when their result type can actually carry a borrow — an owned
		// `string` (or any non-view, view-field-free type) owns its storage
		// outright (a `to_string` materialization, a literal), so tainting it
		// with the view arguments' borrows is a false positive.
		const result_carries = type_can_carry_view_borrow(ret.type, status);
		const infos = result_carries
			? ctor_call_view_borrow(ret.value as FunctionCallNode, status)
			: undefined;
		if (infos?.size && ![...infos.keys()].every((o) => o === "self")) {
			add_error(
				status,
				`cannot return '${ret.type.name}' — its 'view' field(s) borrow from this scope`,
				ret.value.start,
			);
		}
	}

	// ERRORS_PLAN post-check wrap: a bare, non-shorthand value lifts by its
	// checked type — T into the ok case, the error value into the fail case
	// (for a composed set: a member enum wraps through its origin tag, the
	// whole composed value passes into the fail slot), an explicit Result
	// passes through. The synthesized ctor calls carry the same checked
	// state the shorthand-call branch stamps (mangled name, mono type,
	// is_static, is_enum_shorthand) plus the payload-contract helpers, so
	// every backend builds them exactly like user-written cases.
	if (fn?.returns_result && ret.value && fn.return_type.name && fn.return_type.name !== "?") {
		const result_enum = status.enums.findLast((e) => e.name === fn.return_type.name);
		const ok_case = result_enum?.cases.find((c) => c.name === "ok");
		const fail_case = result_enum?.cases.find((c) => c.name === "fail");
		const is_result_like =
			result_enum?.template_name === "Result" || result_enum?.template_name === "UnitResult";
		if (is_result_like && fail_case?.params[0]) {
			const value_name = mono_type_name(ret.type);
			const has_ok_payload = !!ok_case?.params[0];
			const ok_name = has_ok_payload ? mono_type_name(ok_case.params[0].type) : undefined;
			const fail_name = mono_type_name(fail_case.params[0].type);
			const make_case_call = (
				mono: string,
				case_name: string,
				enum_case: { params: Array<import("../nodes/ParameterNode.ts").default> },
				args: BaseNode[],
				start: number,
			): FunctionCallNode => {
				const call = new FunctionCallNode(
					start,
					`${mono}_${case_name}`,
					new Type(mono),
					args,
					true,
				);
				call.is_enum_shorthand = true;
				enforce_case_payload_ownership(case_name, enum_case.params, call.params, call, status);
				stamp_in_place_enum_payloads(enum_case, call.params, call, status);
				hoist_case_string_arg_temp(
					enum_case.params,
					call.params,
					status,
					call.in_place_payload_indices,
				);
				return call;
			};
			if (ret.type.name === fn.return_type.name) {
				// Already a Result — explicit pass-through.
			} else if (has_ok_payload && value_name === ok_name) {
				const wrapped = make_case_call(
					result_enum.name,
					"ok",
					ok_case,
					[ret.value],
					ret.value.start,
				);
				ret.value = wrapped;
				ret.type = wrapped.type;
			} else if (value_name === fail_name) {
				// The whole E value (the single member enum / the composed set).
				const wrapped = make_case_call(
					result_enum.name,
					"fail",
					fail_case,
					[ret.value],
					ret.value.start,
				);
				ret.value = wrapped;
				ret.type = wrapped.type;
			} else if (fn_composed) {
				// One of the composed set's member enums — wrap it through its
				// origin tag, then into the Result's fail case.
				const member = fn_members.find((m) => mono_type_name(m) === value_name);
				const composed_enum = member
					? status.enums.findLast((e) => e.name === fail_name)
					: undefined;
				const composed_case = member && composed_enum?.cases.find((c) => c.name === member.name);
				if (member && composed_enum && composed_case) {
					const inner = make_case_call(
						composed_enum.name,
						member.name,
						composed_case,
						[ret.value],
						ret.value.start,
					);
					const wrapped = make_case_call(
						result_enum.name,
						"fail",
						fail_case,
						[inner],
						ret.value.start,
					);
					ret.value = wrapped;
					ret.type = wrapped.type;
				}
			} else if (fn.unit_result) {
				// `out ! E` with a plain value (e.g. `return load(path)!`):
				// the function has no success slot, so the value is evaluated
				// and DISCARDED, then the call succeeds — the natural spelling
				// for "propagate the error, forget the payload".
				ret.unit_discard = true;
				ret.type = fn.return_type;
			}
		}
	}

	if (func) {
		if (func.return_type.name === "func") {
			// A func-typed return (`out func (out int)` — a closure factory):
			// the value is a lambda, a named function, or another func value.
			// type_from_value_node of a lambda is its RETURN type (the usual
			// func quirk), so the scalar comparison is skipped. An untyped
			// lambda merges its signature from the return type, and
			// returning a CAPTURING closure transfers ownership to the
			// caller (a donating func-typed local is invalidated).
			const value_func =
				ret.value.node_type === "func"
					? (ret.value as import("../nodes/FunctionNode.ts").default)
					: undefined;
			if (value_func && !value_func.name) {
				// An anonymous lambda in return position needs an emission
				// name — the same synthesis a call-argument lambda gets
				// (both backends lower it to a file-scope function).
				synthesize_lambda_name(value_func, status);
			}
			if (ret.value.node_type === "value" && !value_func) {
				// A bare name in return position (`return five`): when it
				// names a FUNCTION (not a local — a local shadows the table),
				// stamp the resolution so the build materializes the closure
				// descriptor at this site rather than the raw code address.
				// The value's own stamped type may be the function's RETURN
				// type (the out-signature StackValue convention), which is
				// why check_value_node's stamp didn't fire.
				const name = (ret.value as ValueNode).value;
				const is_local = status.values.some((v) => v.name === name);
				if (!is_local) {
					const fn = status.functions.findLast((f) => f.name === name);
					if (fn) {
						(ret.value as unknown as { resolved_function?: FunctionNode }).resolved_function = fn;
					}
				}
			}
			const sig = func.return_type;
			if (value_func && sig.func_params?.length) {
				if (value_func.params.length === sig.func_params.length) {
					for (let i = 0; i < value_func.params.length; i++) {
						if (!value_func.params[i].type.name && sig.func_params[i].type.name) {
							value_func.params[i].type = sig.func_params[i].type;
							value_func.params[i].type_start = sig.func_params[i].type_start;
						}
						if (sig.func_params[i].func_params && !value_func.params[i].func_params) {
							// A nested func parameter carries its own signature —
							// copy it so the lambda body can call through it.
							value_func.params[i].func_params = sig.func_params[i].func_params;
							value_func.params[i].func_return_type = sig.func_params[i].func_return_type;
						}
					}
				}
			}
			if (value_func) {
				check_merged_missing_return(value_func, status);
			}
			// The returned func value's signature must match the declared
			// return (arity + parameter types + result, nested included) —
			// the same check arguments get. Runs after the lambda merge so a
			// correctly-inferred lambda compares equal.
			check_func_argument_signature(sig, ret.value, status, ret.value.start);
			move_closure_source(ret.value, status);
		} else if (func.return_type.name) {
			if (ret.unit_discard) {
				// `return <value>` in a unit-result function: the value was
				// evaluated for effect (stamped above) — no type comparison.
			} else if (func.return_type.name !== "?") {
				const return_type = type_from_value_node(ret.value, status);
				const return_value = value_from_value_node(ret.value);
				const error_pos = ret.value.node_type === "grouped" ? ret.start + 2 : ret.value.start;
				check_type_and_value_match(
					func.return_type,
					return_type,
					return_value,
					status,
					error_pos,
					"return",
				);
				func.return_type.is_static = return_type.is_static;
			}
		} else if (!(func as import("../nodes/FunctionNode.ts").default).is_arrow_body) {
			add_error(status, `Function returns a value but has no 'out' return type`, ret.start);
			func.return_type = ret.type;
		} else {
			func.return_type = ret.type;
			// An arrow-body lambda whose single expression is a VOID call
			// (`() => Console.write_line("x")`, `() => ch.send(1)`) yields no
			// value: the call's type carries an empty name, which would leave
			// the lambda's return type unnamed and the backends emitting a
			// value-returning body (`long _return_val = <void call>`) for it.
			// Normalize to void — the same Type a bare `return` produces — so
			// the implicit return lowers as a plain statement.
			if (!ret.type?.name) {
				func.return_type = new Type("void");
				ret.type = new Type("void");
			}
		}
	}
}
