import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessIndexNode from "../../nodes/AccessIndexNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import ArrayValuesNode from "../../nodes/ArrayValuesNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import CastNode from "../../nodes/CastNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import GroupedNode from "../../nodes/GroupedNode.ts";
import IfElseNode from "../../nodes/IfElseNode.ts";
import MatchNode from "../../nodes/MatchNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import RangeNode from "../../nodes/RangeNode.ts";
import SwitchNode from "../../nodes/SwitchNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_from_value from "./type_from_value.ts";

export default function type_from_value_node(node: BaseNode, status: CheckStatus): Type {
	switch (node.node_type) {
		case "value": {
			return type_from_value((node as ValueNode).value, status);
		}
		case "access": {
			return type_from_value_node((node as AccessNode).access, status);
		}
		case "array": {
			const type = (node as ArrayValuesNode).type;
			type.is_array = true;
			return type;
		}
		case "func_call": {
			return (node as FunctionCallNode).type;
		}
		case "access_field": {
			return (node as AccessFieldNode).type;
		}
		case "access_func": {
			return (node as AccessFunctionCallNode).type;
		}
		case "access_index": {
			return (node as AccessIndexNode).type;
		}
		case "if": {
			return (node as IfElseNode).return_type;
		}
		case "cast": {
			return (node as CastNode).target_type;
		}
		case "match": {
			return (node as MatchNode).return_type;
		}
		case "switch": {
			return (node as SwitchNode).return_type;
		}
		case "grouped": {
			return type_from_value_node((node as GroupedNode).value, status);
		}
		case "op": {
			return (node as OperationNode).type;
		}
		case "range": {
			return (node as RangeNode).type;
		}
	}
	return new Type("");
}
