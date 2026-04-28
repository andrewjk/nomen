import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessIndexNode from "../../nodes/AccessIndexNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import ArrayValuesNode from "../../nodes/ArrayValuesNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import GroupedNode from "../../nodes/GroupedNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import RangeNode from "../../nodes/RangeNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";

export default function type_from_value_node(node: BaseNode): Type {
	switch (node.node_type) {
		case "access": {
			return type_from_value_node((node as AccessNode).access);
		}
		case "value": {
			return (node as ValueNode).type;
		}
		case "array": {
			return (node as ArrayValuesNode).type;
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
		case "grouped": {
			return type_from_value_node((node as GroupedNode).value);
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
