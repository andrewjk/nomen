import add_error from "../add_error.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { borrow_depth_of, borrow_owner_of } from "./utils/borrow.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

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
					`Cannot return class parameter '${param.name}' without 'mov' — would create shared reference`,
					ret.value.start,
				);
			}
		}
	}

	// A borrowed class reference must not be returned — it would escape the
	// function scope and outlive the instance it points into. Use `mov` (with
	// swap) to transfer ownership instead. The one exception is a `view T`
	// return that borrows from `self` (the receiver): a slice method hands back
	// a non-owning borrow that the caller re-roots at the call-site receiver
	// (see borrow_depth_of), so returning it is sound. A view borrowing from a
	// non-self param/local still escapes and is rejected.
	if (func && borrow_depth_of(ret.value, status) !== undefined) {
		const safe_view_from_self =
			!!func.return_type?.is_view && borrow_owner_of(ret.value, status) === "self";
		if (!safe_view_from_self) {
			add_error(
				status,
				`cannot return a borrowed reference — use 'mov' (with swap) to transfer ownership`,
				ret.value.start,
			);
		}
	}

	if (func) {
		if (func.return_type.name) {
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
