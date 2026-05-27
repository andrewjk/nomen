import add_error from "../add_error.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

function get_null_check_var(condition: BaseNode): { name: string; is_null_check: boolean } | null {
	if (condition.node_type !== "op") return null;
	const op = condition as OperationNode;
	if (op.op !== "==" && op.op !== "!=") return null;

	const left = op.left_value;
	const right = op.right_value;
	const is_eq = op.op === "==";

	if (left.node_type === "value" && right.node_type === "value") {
		const lv = left as ValueNode;
		const rv = right as ValueNode;
		if (rv.value === "null" && lv.type?.is_nullable) {
			return { name: lv.value, is_null_check: is_eq };
		}
		if (lv.value === "null" && rv.type?.is_nullable) {
			return { name: rv.value, is_null_check: is_eq };
		}
	}
	return null;
}

export default function check_if_else_node(if_else: IfElseNode, status: CheckStatus) {
	check_node(if_else.condition, status);
	const condition_type = type_from_value_node(if_else.condition, status);
	if (type_name(condition_type) !== "bool") {
		add_error(
			status,
			`If/else condition must be a bool, not ${type_name(condition_type)}`,
			if_else.condition.start,
		);
	}

	const null_check = get_null_check_var(if_else.condition);

	status.stack.push(if_else);
	let if_status = clone_status(status);
	let else_status = clone_status(status);

	if (null_check) {
		if (!null_check.is_null_check) {
			const if_var = if_status.values.find((v) => v.name === null_check.name);
			if (if_var) if_var.is_null = false;
		} else {
			const else_var = else_status.values.find((v) => v.name === null_check.name);
			if (else_var) else_var.is_null = false;
		}
	}

	if (if_else.if_branch) {
		check_block_node(if_else.if_branch, if_status);
	}
	if (if_else.else_branch) {
		check_block_node(if_else.else_branch, else_status);
	}
	status.stack.pop();

	for (let [i, value] of status.values.entries()) {
		if (value.declaration === "const" && !value.is_set) {
			let is_set_count =
				0 + (if_status.values[i].is_set ? 1 : 0) + (else_status.values[i].is_set ? 1 : 0);
			if (is_set_count === 2) {
				value.is_set = true;
			} else if (is_set_count === 1) {
				add_error(status, `Const set incompletely: ${value.name}`, if_else.start);
			}
		}
	}

	if (if_else.if_branch && !if_else.else_branch) {
		const parent = status.stack.at(-1);
		if (parent && (parent.node_type === "declare" || parent.node_type === "assign")) {
			add_error(status, "If expression must have an else branch", if_else.start);
		}
	}
}
