import add_error from "../add_error";
import BaseNode from "../nodes/BaseNode";
import type BlockNode from "../nodes/BlockNode";
import FunctionNode from "../nodes/FunctionNode";
import ParameterNode from "../nodes/ParameterNode";
import ReturnNode from "../nodes/ReturnNode";
import StructNode from "../nodes/StructNode";
import Type from "../nodes/Type";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import parse_statement from "./parse_statement";
import parse_type from "./parse_type";
import accept from "./utils/accept";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";
import peek_current from "./utils/peek_current";

export default function parse_function(
  visibility: "inherit" | "pub" | "mod" | "priv",
  status: ParseStatus,
) {
  const start = get_index(status);
  accept(visibility, status);
  accept("func", status);
  const name = consume(status);
  const func = new FunctionNode(start, visibility, name, new Type(""));

  if (expect("=", status) && expect("(", status)) {
    const parent = status.stack.at(-1)!;

    if (peek_current(status) !== ")") {
      parse_function_parameter(parent, func, status);
    }

    func.is_static = !func.params[0]?.is_self_param;

    if (expect(")", status)) {
      if (expect("->", status)) {
        const next = peek_current(status);
        if (next === "{") {
          // Block body
          const has_body = parent.node_type === "trait" ? accept("{", status) : expect("{", status);
          if (has_body) {
            func.has_body = true;

            status.stack.push(func);
            parse_statement(status);
            expect("}", status);
            status.stack.pop();

            // TODO: check all branches
            if (func.return_type.name && !func.has_return) {
              add_error(status, `Missing return`, status.tokens[status.i - 1].i);
            }
          }
        } else if (next === "(") {
          // One-line return: -> (expr)
          accept("(", status);
          func.has_body = true;
          func.has_return = true;
          const return_expr = parse_expression(status);
          expect(")", status);
          func.statements.push(new ReturnNode(return_expr.start, return_expr));
        } else {
          add_error(status, `Expected { or (`, get_index(status));
        }

        switch (parent.node_type) {
          case "root":
          case "func": {
            (parent as BlockNode).statements.push(func);
            break;
          }
          case "struct":
          case "trait": {
            (parent as StructNode).functions.push(func);
            break;
          }
          default: {
            add_error(status, "Function cannot appear here", func.start);
          }
        }
      }
    }
  }
}

function parse_function_parameter(parent: BaseNode, func: FunctionNode, status: ParseStatus) {
  const param_start = get_index(status);

  // Check for return type: `out type`
  if (accept("out", status)) {
    func.return_type_start = get_index(status);
    func.return_type = parse_type(status);

    // Next parameter
    if (accept(",", status)) {
      parse_function_parameter(parent, func, status);
    }
    return;
  }

  const param = new ParameterNode(param_start, "");
  func.params.push(param);

  // Optional parameter declaration
  if (accept("var", status)) {
    param.declaration = "var";
  } else if (accept("cp", status)) {
    param.declaration = "var";
    param.is_copied = true;
  }

  // Try parsing a type, and backtrack if it turns out to be a name with default value
  const saved_i = status.i;
  const saved_errors_length = status.errors.length;
  param.type_start = get_index(status);
  param.type = parse_type(status);

  // If the next token is '=' or ')' or ',', what we parsed was actually the name
  const next = peek_current(status);
  if (next === "=" || next === ")" || next === "," || status.i >= status.tokens.length) {
    status.i = saved_i;
    status.errors.length = saved_errors_length;
    param.type = new Type("");
    param.type_start = undefined;
    param.name = consume(status);
  } else {
    param.name_start = get_index(status);
    param.name = consume(status);
  }

  // Struct and trait functions can have a special `self` parameter in first place
  if (
    param.name === "self" &&
    func.params.length === 1 &&
    (parent.node_type === "struct" || parent.node_type === "trait")
  ) {
    param.type_start = param.start;
    param.type = new Type((parent as StructNode).name);
    param.is_self_param = true;

    // Next parameter
    if (accept(",", status)) {
      parse_function_parameter(parent, func, status);
    }

    return;
  }

  // Parameter value
  if (accept("=", status)) {
    param.default_value_start = get_index(status);
    param.default_value = parse_expression(status);
  }

  // Check type or value has been set
  if (!param.type.name && !param.default_value) {
    add_error(status, `Expected type or default value`, param.start);
  }

  // Next parameter
  if (accept(",", status)) {
    parse_function_parameter(parent, func, status);
  }
}
