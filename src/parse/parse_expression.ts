import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import { is_operation_node } from "../nodes/is_node_type.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_access from "./parse_access.ts";
import parse_array_value from "./parse_array_value.ts";
import parse_function_call_parameter from "./parse_function_call_parameter.ts";
import parse_if_else from "./parse_if_else.ts";
import parse_string_interpolation from "./parse_string_interpolation.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

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
    case "(": {
      consume(status);
      node = new GroupedNode(start, parse_expression(status));
      expect(")", status);
      break;
    }
    case "if": {
      node = parse_if_else(status);
      break;
    }
    default: {
      if (value && value.startsWith('"') && (value.length === 1 || !value.endsWith('"'))) {
        node = parse_string_interpolation(status);
      } else {
        value = consume(status);
        node = new ValueNode(start, value);
      }
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
        ////switch (access.access.node_type) {
        ////  case "access_field": {
        ////    value = (access.access as AccessFieldNode).name;
        ////    break;
        ////  }
        ////  case "access_func": {
        ////    value = (access.access as AccessFunctionCallNode).name;
        ////    break;
        ////  }
        ////}
        break;
      }
      case "[": {
        accept("[", status);
        const index = parse_expression(status);
        expect("]", status);
        const access = new AccessNode(node.start, node, new AccessIndexNode(index.start, index));
        node = access;
        ////value = "TODO"; // (access.access as AccessIndexNode).index;
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
        /////value = func.name;
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
        // Like https://en.cppreference.com/w/c/language/operator_precedence
        const expression = parse_expression(status);
        if (is_operation_node(expression)) {
          const current_precedence = operator_precedence(current_value);
          const expression_precedence = operator_precedence(expression.op);
          if (current_precedence < expression_precedence) {
            // Move things from the right to the left
            // E.g. from `a + (b > c)` to `(a + b) > c`
            node = new OperationNode(
              start,
              expression.op,
              new OperationNode(start, current_value, node, expression.left_value),
              expression.right_value,
            );
            break;
          }
        }

        node = new OperationNode(start, current_value, node, expression);
        break;
      }
      case "..": {
        consume(status);
        const range = new RangeNode(start, node, parse_expression(status), false);
        node = range;
        break;
      }
      default: {
        return node;
      }
    }
  }
}

function operator_precedence(op: string) {
  switch (op) {
    case "*":
    case "/":
    case "%": {
      return 3;
    }
    case "+":
    case "-": {
      return 4;
    }
    case "<<":
    case ">>": {
      return 5;
    }
    case "==":
    case "!=": {
      return 7;
    }
    case "&": {
      return 8;
    }
    case "^": {
      return 9;
    }
    case "|": {
      return 10;
    }
    case "&&": {
      return 11;
    }
    case "||": {
      return 12;
    }
    case "=":
    case "+=":
    case "-=":
    case "*=":
    case "/=":
    case "%=":
    case "<<=":
    case ">>=":
    case "&=":
    case "^=":
    case "|=": {
      return 14;
    }
    default: {
      return 100;
    }
  }
}
