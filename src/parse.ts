import check from "./check";
import AccessFieldNode from "./nodes/AccessFieldNode";
import AccessInvocationNode from "./nodes/AccessInvocationNode";
import AccessNode from "./nodes/AccessNode";
import ArrayValuesNode from "./nodes/ArrayValuesNode";
import AssignmentNode from "./nodes/AssignmentNode";
import BaseNode from "./nodes/BaseNode";
import BlockNode from "./nodes/BlockNode";
import DeclarationNode from "./nodes/DeclarationNode";
import ForNode from "./nodes/ForNode";
import FunctionNode from "./nodes/FunctionNode";
import InvocationNode from "./nodes/InvocationNode";
import OperationNode from "./nodes/OperationNode";
import ParameterNode from "./nodes/ParameterNode";
import RangeNode from "./nodes/RangeNode";
import ReturnNode from "./nodes/ReturnNode";
import RootNode from "./nodes/RootNode";
import StructNode from "./nodes/StructNode";
import TraitNode from "./nodes/TraitNode";
import ValueNode from "./nodes/ValueNode";
import tokenize from "./tokenize";
import type CompileError from "./types/CompileError";
import type ParseResult from "./types/ParseResult";
import type Token from "./types/Token";

interface ParseStatus {
  // The tokens
  tokens: Token[];
  // The current token index
  i: number;
  // The current node
  stack: BaseNode[];
  // Errors that have been encountered
  errors: CompileError[];
}

export default function parse(input: string): ParseResult {
  const tokens = tokenize(input);

  const root = new RootNode();

  const status: ParseStatus = {
    tokens,
    i: 0,
    stack: [root],
    errors: [],
  };

  parse_statement(status);

  const checked = check(root);
  const errors = status.errors.concat(checked.errors);

  return {
    ok: !errors.length,
    root,
    errors,
  };
}

function parse_statement(status: ParseStatus) {
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

    // First check for a keyword (var, if, switch, etc), then check for a following operator (=, +, etc)
    switch (value) {
      case "const":
      case "var": {
        parse_declaration(value, status);
        break;
      }
      case "struct": {
        parse_struct(status);
        break;
      }
      case "trait": {
        parse_trait(status);
        break;
      }
      case "func": {
        parse_function(status);
        break;
      }
      case "for": {
        parse_for_loop(status);
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
  const start = index(status);
  const value = consume(status);
  let node: BaseNode = new ValueNode(start, value);

  while (true) {
    const next_value = peek_current(status);
    switch (next_value) {
      case ".": {
        accept(".", status);
        const access = new AccessNode(node.start, node, parse_access(value, status));
        node = access;
        break;
      }
      case "(": {
        accept("(", status);
        const invoke = new InvocationNode(node.start, value);
        if (peek_current(status) !== ")") {
          parse_invocation_parameter(invoke, status);
        }
        expect(")", status);
        node = invoke;
        break;
      }
      case "=": {
        accept("=", status);
        const assign = new AssignmentNode(node.start, node, parse_expression(status));
        node = assign;
        break;
      }
      default: {
        add_to_parent(node, ["root", "func", "for"], node_name(node), status);
        return;
      }
    }
  }
}

/**
 * An expression returns a value and can be used e.g. on the right side of an assignment, as the
 * initial value of a declaration or as a parameter value in a function call
 */
function parse_expression(status: ParseStatus): BaseNode {
  // First check for an array of values
  const start = index(status);
  let value = consume(status);
  let node: BaseNode;
  if (value === "[") {
    node = new ArrayValuesNode(start);
    if (peek_current(status) !== "]") {
      parse_array_value(node as ArrayValuesNode, status);
    }
    expect("]", status);
  } else {
    node = new ValueNode(start, value);
  }

  while (true) {
    const next_value = peek_current(status);
    switch (next_value) {
      case ".": {
        accept(".", status);
        const access = new AccessNode(node.start, node, parse_access(value, status));
        node = access;
        // TODO: This should be a type prop on AccessNode
        switch (access.access.node_type) {
          case "ac_field": {
            value = (access.access as AccessFieldNode).name;
            break;
          }
          case "ac_invoke": {
            value = (access.access as AccessInvocationNode).name;
            break;
          }
        }
        break;
      }
      case "(": {
        accept("(", status);
        const invoke = new InvocationNode(start, value);
        if (peek_current(status) !== ")") {
          parse_invocation_parameter(invoke, status);
        }
        expect(")", status);
        node = invoke;
        value = invoke.name;
        break;
      }
      case "+":
      case "-": {
        consume(status);
        // TODO: Proper order of operations
        const op = new OperationNode(start, next_value, node, parse_expression(status));
        node = op;
        break;
      }
      case "..":
      case ".=": {
        consume(status);
        const range = new RangeNode(start, node, parse_expression(status), next_value === ".=");
        node = range;
        break;
      }
      default: {
        return node;
      }
    }
  }
}

// DECLARATION

function parse_declaration(declaration: "const" | "var", status: ParseStatus) {
  const decl = new DeclarationNode(index(status), declaration, "");

  accept(declaration, status);
  decl.name_start = index(status);
  decl.name = consume(status);
  if (accept(":", status)) {
    decl.type_start = index(status);
    decl.type = consume(status);
    // HACK: Need to be fancier about this -- with a type node?
    if (peek_current(status) === "[") {
      while (!decl.type.endsWith("]")) {
        decl.type += consume(status);
      }
    }
  }
  if (accept("=", status)) {
    decl.value = parse_expression(status);
  }

  // Check type or value has been set
  if (!decl.type && !decl.value) {
    status.errors.push({
      message: `Expected type or default value`,
      start: decl.start + decl.declaration.length + 1,
    });
  }

  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      (parent as BlockNode).statements.push(decl);
      break;
    }
    case "trait":
    case "struct": {
      (parent as StructNode).fields.push(decl);
      break;
    }
    default: {
      status.errors.push({
        message: "Declaration cannot appear here",
        start: decl.start,
      });
    }
  }
}

// STRUCT

function parse_struct(status: ParseStatus) {
  const start = index(status);
  accept("struct", status);
  const name = consume(status);
  const struct = new StructNode(start, name);

  if (accept(":", status)) {
    struct.traits.push(consume(status));
    while (accept(",", status)) {
      struct.traits.push(consume(status));
    }
  }
  if (expect("{", status)) {
    status.stack.push(struct);

    parse_statement(status);
    expect("}", status);

    status.stack.pop();

    // Add the init function to the struct
    // TODO: Allow overriding it
    const func = new FunctionNode(-1, "init", struct.name);
    func.params = struct.fields
      .filter((f) => !f.value)
      .map((f) => new ParameterNode(-1, f.name, f.type));
    struct.functions.unshift(func);

    add_to_parent(struct, ["root", "func"], "Struct", status);
  }
}

// TRAIT

function parse_trait(status: ParseStatus) {
  const start = index(status);

  accept("trait", status);
  const name = consume(status);
  const trait = new TraitNode(start, name);

  if (expect("{", status)) {
    status.stack.push(trait);

    parse_statement(status);
    expect("}", status);

    status.stack.pop();

    add_to_parent(trait, ["root", "func"], "Trait", status);
  }
}

// FUNCTIONS

function parse_function(status: ParseStatus) {
  const start = index(status);
  accept("func", status);
  const name = consume(status);
  const func = new FunctionNode(start, name, "");

  if (expect("(", status)) {
    if (peek_current(status) !== ")") {
      parse_function_parameter(func, status);
    }
    if (expect(")", status)) {
      if (accept("->", status)) {
        func.return_type_start = index(status);
        func.return_type = consume(status);
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

        if (func.return_type && !func.has_return) {
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
  const param = new ParameterNode(index(status), "");
  func.params.push(param);

  // Parameter name
  param.name = consume(status);

  // Parameter type
  if (accept(":", status)) {
    param.type_start = index(status);
    param.type = consume(status);
  }

  // Parameter value
  if (accept("=", status)) {
    param.default_value_start = index(status);
    param.default_value = consume(status);
  }

  // Check type or value has been set
  if (!param.type && !param.default_value) {
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

// FOR LOOP

function parse_for_loop(status: ParseStatus) {
  const for_start = index(status);
  accept("for", status);
  const start = index(status);
  const value = consume(status);
  const item = new ValueNode(start, value);
  // TODO: index option?
  if (expect("in", status)) {
    const list = parse_expression(status);
    if (expect("{", status)) {
      const for_loop = new ForNode(for_start, item, list);

      status.stack.push(for_loop);

      parse_statement(status);
      expect("}", status);

      status.stack.pop();

      add_to_parent(for_loop, ["root", "func"], "For loop", status);
    }
  }
}

// INVOCATION

function parse_invocation_parameter(
  invoke: InvocationNode | AccessInvocationNode,
  status: ParseStatus,
) {
  const param = parse_expression(status);
  invoke.params.push(param);

  // Next parameter
  if (accept(",", status)) {
    parse_invocation_parameter(invoke, status);
  }
}

// RETURN

function parse_return(status: ParseStatus) {
  accept("return", status);

  const value_start = index(status);
  const value = parse_expression(status);
  const ret = new ReturnNode(value_start, value);
  (status.stack.at(-1) as BlockNode).statements.push(ret);

  // Go up the stack looking for our function
  const func = find_parent_of_type("func", status) as FunctionNode;
  if (func) {
    func.has_return = true;
  } else {
    status.errors.push({
      message: "Return outside function",
      start: index(status),
    });
  }
}

// ACCESS

function parse_access(
  source_name: string,
  status: ParseStatus,
): AccessFieldNode | AccessInvocationNode {
  const start = index(status);
  const name = consume(status);

  if (peek_current(status) === "(") {
    accept("(", status);
    const invoke = new AccessInvocationNode(start, name);
    // HACK:
    if (invoke.name === "init") {
      invoke.type = source_name;
      invoke.static = true;
    }
    if (peek_current(status) !== ")") {
      parse_invocation_parameter(invoke, status);
    }
    expect(")", status);
    return invoke;
  } else {
    const field: AccessFieldNode = {
      node_type: "ac_field",
      name,
      type: "",
      start,
    };
    return field;
  }
}

// ARRAY

function parse_array_value(array: ArrayValuesNode, status: ParseStatus) {
  // Get this value
  const value = parse_expression(status);
  array.values.push(value);

  // Maybe get another value
  if (accept(",", status)) {
    parse_array_value(array, status);
  }
}

// PROCESSING

function index(status: ParseStatus): number {
  return status.tokens[status.i].i;
}

function peek_current(status: ParseStatus): string | undefined {
  return status.tokens[status.i]?.value;
}

function peek_next(status: ParseStatus): string | undefined {
  return status.tokens[status.i + 1]?.value;
}

function consume(status: ParseStatus): string {
  if (status.i < status.tokens.length) {
    const result = status.tokens[status.i].value;
    status.i += 1;
    return result;
  } else {
    const last = status.tokens.at(-1);
    status.errors.push({
      message: "Expected token",
      start: last ? last.i + last.value.length : 0,
    });
    return "";
  }
}

function accept(value: string, status: ParseStatus): boolean {
  if (status.i < status.tokens.length) {
    if (status.tokens[status.i].value == value) {
      status.i += 1;
      return true;
    }
  }
  return false;
}

function expect(value: string, status: ParseStatus): boolean {
  if (status.i < status.tokens.length) {
    if (status.tokens[status.i].value == value) {
      status.i += 1;
      return true;
    } else {
      status.errors.push({
        message: `Expected ${value}`,
        start: index(status),
      });
    }
  } else {
    const last = status.tokens.at(-1);
    status.errors.push({
      message: "Expected token",
      start: last ? last.i + last.value.length : 0,
    });
  }
  return false;
}

// UTILS

function add_to_parent(
  node: BaseNode,
  types: string[],
  description: string,
  status: ParseStatus,
): boolean {
  const parent = status.stack.at(-1)!;
  if (types.includes(parent.node_type)) {
    (parent as BlockNode).statements.push(node);
    return true;
  } else {
    status.errors.push({
      message: `${description} cannot appear here`,
      start: node.start,
    });
    return false;
  }
}

function find_parent_of_type(type: string, status: ParseStatus): BaseNode | undefined {
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (status.stack[i].node_type === type) {
      return status.stack[i];
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
