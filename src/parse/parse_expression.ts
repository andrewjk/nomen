import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode";
import AccessNode from "../nodes/AccessNode";
import ArrayValuesNode from "../nodes/ArrayValuesNode";
import BaseNode from "../nodes/BaseNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import OperationNode from "../nodes/OperationNode";
import RangeNode from "../nodes/RangeNode";
import ValueNode from "../nodes/ValueNode";
import type ParseStatus from "./ParseStatus";
import parse_access from "./parse_access";
import parse_array_value from "./parse_array_value";
import parse_function_call_parameter from "./parse_function_call_parameter";
import parse_if_else from "./parse_if_else";
import accept from "./utils/accept";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";
import peek_current from "./utils/peek_current";

/**
 * An expression returns a value and can be used e.g. on the right side of an assignment, as the
 * initial value of a declaration or as a parameter value in a function call
 */
export default function parse_expression(status: ParseStatus): BaseNode {
  const start = get_index(status);
  let value = peek_current(status) || "??";
  let node: BaseNode;

  // Get the initial value
  switch (value) {
    case "[": {
      consume(status);
      node = new ArrayValuesNode(start);
      if (peek_current(status) !== "]") {
        parse_array_value(node as ArrayValuesNode, status);
      }
      expect("]", status);
      break;
    }
    case "if": {
      node = parse_if_else(status);
      break;
    }
    default: {
      value = consume(status);
      node = new ValueNode(start, value);
    }
  }

  // Get any accesses or operations applied to the value
  while (true) {
    const current_value = peek_current(status);
    switch (current_value) {
      case ".": {
        accept(".", status);
        const access = new AccessNode(node.start, node, parse_access(value, status));
        node = access;
        // TODO: This should be a type prop on AccessNode
        switch (access.access.node_type) {
          case "access_field": {
            value = (access.access as AccessFieldNode).name;
            break;
          }
          case "access_func": {
            value = (access.access as AccessFunctionCallNode).name;
            break;
          }
        }
        break;
      }
      case "(": {
        accept("(", status);
        const func = new FunctionCallNode(start, value);
        if (peek_current(status) !== ")") {
          parse_function_call_parameter(func, status);
        }
        expect(")", status);
        node = func;
        value = func.name;
        break;
      }
      case "+":
      case "-":
      case "*":
      case "/":
      case "%":
      case "==":
      case "!=":
      case ">":
      case ">=":
      case "<":
      case "<=":
      case "&&":
      case "||": {
        consume(status);
        // TODO: Proper order of operations
        const op = new OperationNode(start, current_value, node, parse_expression(status));
        node = op;
        break;
      }
      case "..":
      case ".=": {
        consume(status);
        const range = new RangeNode(start, node, parse_expression(status), current_value === ".=");
        node = range;
        break;
      }
      default: {
        return node;
      }
    }
  }
}
