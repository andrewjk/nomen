import add_error from "../add_error.ts";
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
import check_merged_missing_return from "./utils/check_merged_missing_return.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import synthesize_lambda_name from "./utils/synthesize_lambda_name.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";
import {
	ctor_call_view_borrow,
	type_can_carry_view_borrow,
	view_borrows_root_at_self,
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
		if (func && !func.return_type.name) {
			func.return_type = new Type("void");
		}
		ret.type = new Type("void");
		return;
	}

	const old_expected_type = status.expected_type;
	if (func?.return_type?.name && func.return_type.name !== "?") {
		status.expected_type = func.return_type;
	}

	if (!check_node(ret.value, status)) {
		status.expected_type = old_expected_type;
		return;
	}
	status.expected_type = old_expected_type;

	ret.type = type_from_value_node(ret.value, status);

	if (func && ret.type && is_class_type(ret.type.name, status)) {
		const value_node = get_inner_value_node(ret.value);
		if (value_node) {
			const param = (func as import("../nodes/FunctionNode.ts").default).params.find(
				(p) => p.name === value_node.value,
			);
			if (param && is_class_type(param.type.name, status) && !param.is_moved) {
				add_error(
					status,
					`Cannot return class parameter '${param.name}' without 'move' — would create shared reference`,
					ret.value.start,
				);
			}
		}
	}

	// A borrowed class reference must not be returned IMPLICITLY — it would
	// escape the function scope and outlive the instance it points into. Use
	// `move` to make the escape explicit (for a borrow, the caller receives a
	// non-owning reference — classified at the call site by the method-borrow
	// rules) or `move … swap …` to transfer a replacement in. The other
	// exception is a `view T` return that borrows from `self` (the receiver):
	// a slice method hands back a non-owning borrow that the caller re-roots
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
			// slices of someone else's storage, and `move` cannot transfer that
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
					`cannot return a borrowed reference — use 'move' (with swap) to transfer ownership`,
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
				if (value_func.params.length !== sig.func_params.length) {
					add_error(
						status,
						`Function signature mismatch: expected ${sig.func_params.length} parameter(s)`,
						ret.value.start,
					);
				} else {
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
			move_closure_source(ret.value, status);
		} else if (func.return_type.name) {
			if (func.return_type.name !== "?") {
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
		}
	}
}
