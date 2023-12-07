import check from "./check";
import tokenize from "./tokenize";
import type AccessFieldNode from "./types/AccessFieldNode";
import type AccessInvocationNode from "./types/AccessInvocationNode";
import type AccessNode from "./types/AccessNode";
import type ArrayValuesNode from "./types/ArrayValuesNode";
import type AssignmentNode from "./types/AssignmentNode";
import type CompileError from "./types/CompileError";
import type DeclarationNode from "./types/DeclarationNode";
import type ForNode from "./types/ForNode";
import type FunctionNode from "./types/FunctionNode";
import type InvocationNode from "./types/InvocationNode";
import type OperationNode from "./types/OperationNode";
import type ParameterNode from "./types/ParameterNode";
import type ParseNode from "./types/ParseNode";
import type ParseResult from "./types/ParseResult";
import type RangeNode from "./types/RangeNode";
import type ReturnNode from "./types/ReturnNode";
import type StructNode from "./types/StructNode";
import type Token from "./types/Token";
import type TraitNode from "./types/TraitNode";
import type ValueNode from "./types/ValueNode";

interface ParseStatus {
  // The tokens
  tokens: Token[];
  // The current token index
  i: number;
  // The current node
  stack: ParseNode[];
  // Errors that have been encountered
  errors: CompileError[];
}

export default function parse(input: string): ParseResult {
  const tokens = tokenize(input);

  const root: ParseNode = {
    node_type: "root",
    children: [],
    i: 0,
  };

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
  const i = status.tokens[status.i].i;
  const value = consume(status);
  let node: ParseNode = {
    node_type: "value",
    value,
    type: "",
    children: [],
    i,
  } as ValueNode;

  while (true) {
    const next_value = peek_current(status);
    switch (next_value) {
      case ".": {
        accept(".", status);
        const access: AccessNode = {
          node_type: "access",
          source: node,
          access: parse_access(value, status),
          children: [],
          i: node.i,
        };
        node = access;
        break;
      }
      case "(": {
        accept("(", status);
        const invoke: InvocationNode = {
          node_type: "invoke",
          name: value,
          params: [],
          type: "",
          children: [],
          i: node.i,
        };
        if (peek_current(status) !== ")") {
          parse_invocation_parameter(invoke, status);
        }
        expect(")", status);
        node = invoke;
        break;
      }
      case "=": {
        accept("=", status);
        const assign: AssignmentNode = {
          node_type: "assign",
          left_value: node,
          right_value: parse_expression(status),
          children: [],
          i: node.i,
        };
        node = assign;
        break;
      }
      default: {
        const parent = status.stack.at(-1)!;
        switch (parent.node_type) {
          case "root":
          case "func":
          case "for": {
            parent.children.push(node);
            break;
          }
          default: {
            status.errors.push({
              message: `${node_name(node)} cannot appear here`,
              start: node.i,
            });
            return;
          }
        }
        return;
      }
    }
  }
}

/**
 * An expression returns a value and can be used e.g. on the right side of an assignment, as the
 * initial value of a declaration or as a parameter value in a function call
 */
function parse_expression(status: ParseStatus): ParseNode {
  // First check for an array of values
  const i = status.tokens[status.i].i;
  let value = consume(status);
  let node: ParseNode;
  if (value === "[") {
    node = {
      node_type: "array",
      values: [],
      type: "",
      children: [],
      i,
    } as ArrayValuesNode;
    if (peek_current(status) !== "]") {
      parse_array_value(node as ArrayValuesNode, status);
    }
    expect("]", status);
  } else {
    node = {
      node_type: "value",
      value,
      type: "",
      children: [],
      i,
    } as ValueNode;
  }

  while (true) {
    const next_value = peek_current(status);
    switch (next_value) {
      case ".": {
        accept(".", status);
        const access: AccessNode = {
          node_type: "access",
          source: node,
          access: parse_access(value, status),
          children: [],
          i: node.i,
        };
        node = access;
        // TODO: This should be a type prop on AccessNode
        switch (access.access.node_type) {
          case "accfld": {
            value = (access.access as AccessFieldNode).name;
            break;
          }
          case "accinv": {
            value = (access.access as AccessInvocationNode).name;
            break;
          }
        }
        break;
      }
      case "(": {
        accept("(", status);
        const invoke: InvocationNode = {
          node_type: "invoke",
          name: value,
          params: [],
          type: "",
          children: [],
          i,
        };
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
        const op: OperationNode = {
          node_type: "op",
          op: next_value,
          left_value: node,
          // TODO: Proper order of operations
          right_value: parse_expression(status),
          type: "",
          children: [],
          i,
        };
        node = op;
        break;
      }
      case "..":
      case ".=": {
        consume(status);
        const range: RangeNode = {
          node_type: "range",
          left_value: node,
          right_value: parse_expression(status),
          inclusive: next_value === ".=",
          children: [],
          i,
        };
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
  const decl: DeclarationNode = {
    node_type: "decl",
    declaration,
    name: "",
    type: "",
    children: [],
    i: status.tokens[status.i].i,
  };
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(decl);
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
        start: decl.i,
      });
      consume(status);
      return;
    }
  }

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
      start: decl.i + decl.declaration.length + 1,
    });
  }
}

// STRUCT

function parse_struct(status: ParseStatus) {
  const struct: StructNode = {
    node_type: "struct",
    name: "",
    traits: [],
    fields: [],
    functions: [],
    children: [],
    i: status.tokens[status.i].i,
  };
  status.stack.push(struct);

  accept("struct", status);
  struct.name = consume(status);
  if (accept(":", status)) {
    struct.traits.push(consume(status));
    while (accept(",", status)) {
      struct.traits.push(consume(status));
    }
  }
  if (expect("{", status)) {
    parse_statement(status);
    expect("}", status);
  }

  // Add the init function to the struct
  struct.functions.unshift({
    node_type: "func",
    name: "init",
    params: struct.fields
      .filter((f) => !f.value)
      .map((f) => {
        return {
          node_type: "param",
          name: f.name,
          type: f.type,
          default_value: f.value,
          children: [],
          i: 0,
        } as ParameterNode;
      }),
    return_type: struct.name,
    children: [],
    i: 0,
  } as FunctionNode);

  status.stack.pop();

  // TODO: Add the default fields and functions from the trait?
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(struct);
      break;
    }
    default: {
      status.errors.push({
        message: "Struct cannot appear here",
        start: struct.i,
      });
      break;
    }
  }
}

// TRAIT

function parse_trait(status: ParseStatus) {
  const trait: TraitNode = {
    node_type: "trait",
    name: "",
    fields: [],
    functions: [],
    children: [],
    i: status.tokens[status.i].i,
  };
  status.stack.push(trait);

  accept("trait", status);
  trait.name = consume(status);
  if (expect("{", status)) {
    parse_statement(status);
    expect("}", status);
  }

  status.stack.pop();

  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(trait);
      break;
    }
    default: {
      status.errors.push({
        message: "Trait cannot appear here",
        start: trait.i,
      });
      break;
    }
  }
}

// FUNCTIONS

function parse_function(status: ParseStatus) {
  const func: FunctionNode = {
    node_type: "func",
    name: "",
    params: [],
    return_type: "",
    children: [],
    i: status.tokens[status.i].i,
  };
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(func);
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
        start: func.i,
      });
      consume(status);
      return;
    }
  }

  status.stack.push(func);

  accept("func", status);
  func.name = consume(status);

  if (expect("(", status)) {
    if (peek_current(status) !== ")") {
      parse_function_parameter(func, status);
    }
    if (expect(")", status)) {
      if (accept("->", status)) {
        func.return_type_start = index(status);
        func.return_type = consume(status);
      }
      // Traits don't need a body, everything else does
      const has_body =
        parent.node_type === "trait"
          ? accept("{", status)
          : expect("{", status);
      if (has_body) {
        func.has_body = true;
        parse_statement(status);
        if (expect("}", status)) {
          if (func.return_type && !func.has_return) {
            status.errors.push({
              message: `Missing return`,
              start: status.tokens[status.i - 1].i,
            });
          }
        }
      }
    }
  }

  status.stack.pop();
}

function parse_function_parameter(func: FunctionNode, status: ParseStatus) {
  const param: ParameterNode = {
    node_type: "param",
    name: "",
    type: "",
    children: [],
    i: status.tokens[status.i].i,
  };
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
  const for_loop: ForNode = {
    node_type: "for",
    children: [],
    i: status.tokens[status.i].i,
  };
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(for_loop);
      break;
    }
    default: {
      status.errors.push({
        message: "For cannot appear here",
        start: for_loop.i,
      });
      consume(status);
      return;
    }
  }

  status.stack.push(for_loop);

  accept("for", status);
  for_loop.item = {
    node_type: "value",
    value: consume(status),
    type: "",
    children: [],
    i: status.tokens[status.i].i,
  } as ValueNode;
  // TODO: index option?
  if (expect("in", status)) {
    for_loop.list = parse_expression(status);
    if (expect("{", status)) {
      parse_statement(status);
      expect("}", status);
    }
  }

  status.stack.pop();
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
  const ret: ReturnNode = {
    node_type: "ret",
    value,
    type: "",
    children: [],
    i: value_start,
  };
  status.stack.at(-1)!.children.push(ret);

  // Go up the stack looking for our function
  const func = find_parent_of_type("func", status) as FunctionNode;
  if (func) {
    func.has_return = true;
  } else {
    status.errors.push({
      message: "Return outside function",
      start: status.tokens[status.i].i,
    });
  }
}

// ACCESS

function parse_access(
  source_name: string,
  status: ParseStatus,
): AccessFieldNode | AccessInvocationNode {
  const i = status.tokens[status.i].i;
  const name = consume(status);

  if (peek_current(status) === "(") {
    accept("(", status);
    const invoke: AccessInvocationNode = {
      node_type: "accinv",
      name,
      params: [],
      type: "",
      children: [],
      i,
    };
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
      node_type: "accfld",
      name,
      type: "",
      children: [],
      i,
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
        start: status.tokens[status.i].i,
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

function find_parent_of_type(
  type: string,
  status: ParseStatus,
): ParseNode | undefined {
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (status.stack[i].node_type === type) {
      return status.stack[i];
    }
  }
}

function node_name(node: ParseNode) {
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
