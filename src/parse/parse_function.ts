import type BlockNode from "../nodes/BlockNode";
import FunctionNode from "../nodes/FunctionNode";
import ParameterNode from "../nodes/ParameterNode";
import StructNode from "../nodes/StructNode";
import Type from "../nodes/Type";
import type ParseStatus from "./ParseStatus";
import parse_statement from "./parse_statement";
import parse_type from "./parse_type";
import accept from "./utils/accept";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";
import peek_current from "./utils/peek_current";

export default function parse_function(visibility: "def" | "pub" | "sec", status: ParseStatus) {
  const start = get_index(status);
  accept(visibility, status);
  accept("func", status);
  const name = consume(status);
  const func = new FunctionNode(start, visibility, name, new Type(""));

  if (expect("(", status)) {
    if (peek_current(status) !== ")") {
      parse_function_parameter(func, status);
    }
    if (expect(")", status)) {
      if (accept("->", status)) {
        func.return_type_start = get_index(status);
        func.return_type = parse_type(status);
      }

      const parent = status.stack.at(-1)!;

      // Traits don't need a body, everything else does
      const has_body = parent.node_type === "trait" ? accept("{", status) : expect("{", status);
      if (has_body) {
        func.has_body = true;

        status.stack.push(func);
        parse_statement(status);
        expect("}", status);
        status.stack.pop();

        // TODO: check all branches
        if (func.return_type.name && !func.has_return) {
          status.errors.push({
            message: `Missing return`,
            start: status.tokens[status.i - 1].i,
          });
        }
      }

      switch (parent.node_type) {
        case "root":
        case "func": {
          (parent as BlockNode).statements.push(func);
          break;
        }
        case "trait":
        case "struct": {
          (parent as StructNode).functions.push(func);
          break;
        }
        default: {
          status.errors.push({
            message: "Function cannot appear here",
            start: func.start,
          });
        }
      }
    }
  }
}

function parse_function_parameter(func: FunctionNode, status: ParseStatus) {
  const param = new ParameterNode(get_index(status), "");
  func.params.push(param);

  // Parameter name
  param.name = consume(status);

  // Parameter type
  if (accept(":", status)) {
    param.type_start = get_index(status);
    param.type = parse_type(status);
  }

  // Parameter value
  if (accept("=", status)) {
    param.default_value_start = get_index(status);
    param.default_value = consume(status);
  }

  // Check type or value has been set
  if (!param.type.name && !param.default_value) {
    status.errors.push({
      message: `Expected type or default value`,
      start: status.tokens[status.i - 1].i,
    });
  }

  // Next parameter
  if (accept(",", status)) {
    parse_function_parameter(func, status);
  }
}
