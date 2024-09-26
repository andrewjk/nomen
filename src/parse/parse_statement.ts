import AccessNode from "../nodes/AccessNode";
import AssignmentNode from "../nodes/AssignmentNode";
import BaseNode from "../nodes/BaseNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import ValueNode from "../nodes/ValueNode";
import type ParseStatus from "./ParseStatus";
import parse_access from "./parse_access";
import parse_break_or_continue from "./parse_break_or_continue";
import parse_declaration from "./parse_declaration";
import parse_expression from "./parse_expression";
import parse_for_loop from "./parse_for_loop";
import parse_function from "./parse_function";
import parse_function_call_parameter from "./parse_function_call_parameter";
import parse_if_else from "./parse_if_else";
import parse_panic_or_todo from "./parse_panic_or_todo";
import parse_return from "./parse_return";
import parse_struct from "./parse_struct";
import parse_trait from "./parse_trait";
import parse_visibility from "./parse_visibility";
import parse_while_loop from "./parse_while_loop";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";
import peek_current from "./utils/peek_current";

export default function parse_statement(status: ParseStatus) {
  while (true) {
    const value = peek_current(status);
    if (!value) {
      break;
    }

    // Ignore comments
    if (value.startsWith("//") || value.startsWith("/*")) {
      consume(status);
      continue;
    }

    // First check for a keyword (var, if, switch, etc), then check for a
    // following operator (=, +, etc)
    switch (value) {
      case "pub":
      case "private": {
        parse_visibility(value, status);
        break;
      }
      case "const":
      case "var": {
        parse_declaration("mod", value, status);
        break;
      }
      case "struct": {
        parse_struct("mod", status);
        break;
      }
      case "trait": {
        parse_trait("mod", status);
        break;
      }
      case "func": {
        parse_function("mod", status);
        break;
      }
      case "if": {
        const if_else = parse_if_else(status);
        if (if_else) {
          add_to_parent(if_else, "If expression", status);
        }
        break;
      }
      case "else": {
        return;
      }
      case "for": {
        parse_for_loop(status);
        break;
      }
      case "while": {
        parse_while_loop(status);
        break;
      }
      case "break":
      case "continue": {
        parse_break_or_continue(value, status);
        break;
      }
      case "panic":
      case "todo": {
        parse_panic_or_todo(value, status);
        break;
      }
      case "return": {
        parse_return(status);
        break;
      }
      case "}": {
        return;
      }
      default: {
        parse_statement_start(status);
        break;
      }
    }
  }
}

function parse_statement_start(status: ParseStatus) {
  const start = get_index(status);
  const value = consume(status);
  let node: BaseNode = new ValueNode(start, value);

  while (true) {
    const current_value = peek_current(status);
    switch (current_value) {
      case ".": {
        accept(".", status);
        const access = new AccessNode(node.start, node, parse_access(value, status));
        node = access;
        break;
      }
      case "(": {
        accept("(", status);
        const func = new FunctionCallNode(node.start, value);
        if (peek_current(status) !== ")") {
          parse_function_call_parameter(func, status);
        }
        expect(")", status);
        node = func;
        break;
      }
      case "=": {
        accept("=", status);
        const assign = new AssignmentNode(node.start, node, parse_expression(status));
        node = assign;
        break;
      }
      default: {
        add_to_parent(node, node_name(node), status);
        return;
      }
    }
  }
}

function node_name(node: BaseNode) {
  switch (node.node_type) {
    case "declare": {
      return "Declaration";
    }
    case "assign": {
      return "Assignment";
    }
    default: {
      return node.node_type;
    }
  }
}
