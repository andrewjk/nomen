import check from "./check";
import AccessFieldNode from "./nodes/AccessFieldNode";
import AccessInvocationNode from "./nodes/AccessInvocationNode";
import AccessNode from "./nodes/AccessNode";
import ArrayValuesNode from "./nodes/ArrayValuesNode";
import AssignmentNode from "./nodes/AssignmentNode";
import BaseNode from "./nodes/BaseNode";
import type BlockNode from "./nodes/BlockNode";
import BranchNode from "./nodes/BranchNode";
import BreakNode from "./nodes/BreakNode";
import ContinueNode from "./nodes/ContinueNode";
import DeclarationNode from "./nodes/DeclarationNode";
import ForLoopNode from "./nodes/ForLoopNode";
import FunctionNode from "./nodes/FunctionNode";
import IfElseNode from "./nodes/IfElseNode";
import InvocationNode from "./nodes/InvocationNode";
import OperationNode from "./nodes/OperationNode";
import PanicNode from "./nodes/PanicNode";
import ParameterNode from "./nodes/ParameterNode";
import RangeNode from "./nodes/RangeNode";
import ReturnNode from "./nodes/ReturnNode";
import ReturningNode from "./nodes/ReturningNode";
import RootNode from "./nodes/RootNode";
import StructNode from "./nodes/StructNode";
import TodoNode from "./nodes/TodoNode";
import TraitNode from "./nodes/TraitNode";
import Type from "./nodes/Type";
import ValueNode from "./nodes/ValueNode";
import WhileLoopNode from "./nodes/WhileLoopNode";
import isBlockNode from "./nodes/isBlockNode";
import isReturningNode from "./nodes/isReturningNode";
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
  const errors = status.errors.concat(checked.errors).sort((a, b) => a.start - b.start);

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
      case "pub":
      case "sec": {
        parse_visibility(value, status);
        break;
      }
      case "const":
      case "var": {
        parse_declaration("def", value, status);
        break;
      }
      case "struct": {
        parse_struct("def", status);
        break;
      }
      case "trait": {
        parse_trait("def", status);
        break;
      }
      case "func": {
        parse_function("def", status);
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
  const start = index(status);
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
        add_to_parent(node, node_name(node), status);
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
  const start = index(status);
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
      const if_else = parse_if_else(status);
      if (if_else) {
        node = if_else;
      } else {
        // TODO: ??
        throw new Error("Bad if statement...");
      }
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

function parse_type(status: ParseStatus): Type {
  const type = new Type(consume(status));
  if (accept("[", status)) {
    type.is_array = true;
    if (peek_current(status) !== "]") {
      // TODO: Should be parsing expression
      type.length = new ValueNode(index(status), consume(status));
    }
    expect("]", status);
  }
  return type;
}

function parse_visibility(visibility: "pub" | "sec", status: ParseStatus) {
  // All code is internal by default
  // Anything in the current package has access to anything else
  // Although it has to be imported if it is in another file
  // You can add `pub` to declarations, structs, traits and funcs to make them public (i.e. accessible from other packages)
  // You can add `sec` to declarations, structs, traits and funcs to make them secret (i.e. cannot be accessed from other scopes)
  // Initializers inherit the visibility of their struct
  // Struct and trait declarations and functions do not inherit the visibility of their parent -- you must set `pub` or `sec` for each field

  const next = peek_next(status);
  switch (next) {
    case "const":
    case "var": {
      if (visibility === "sec" && status.stack.at(-1)?.node_type === "trait") {
        status.errors.push({
          message: `Trait fields cannot be secret`,
          start: index(status),
        });
        consume(status);
      } else {
        parse_declaration(visibility, next, status);
      }
      break;
    }
    case "struct": {
      parse_struct(visibility, status);
      break;
    }
    case "trait": {
      parse_trait(visibility, status);
      break;
    }
    case "func": {
      if (visibility === "sec" && status.stack.at(-1)?.node_type === "trait") {
        status.errors.push({
          message: `Trait functions cannot be secret`,
          start: index(status),
        });
        consume(status);
      } else {
        parse_function(visibility, status);
      }
      break;
    }
    default: {
      status.errors.push({
        message: `Visibility can only be set for const, var, struct, trait or func`,
        start: index(status),
      });
      consume(status);
    }
  }
}

function parse_declaration(
  visibility: "def" | "pub" | "sec",
  declaration: "const" | "var",
  status: ParseStatus,
) {
  const start = index(status);
  accept(visibility, status);
  const decl = new DeclarationNode(start, visibility, declaration, "");

  accept(declaration, status);
  decl.name_start = index(status);
  decl.name = consume(status);
  if (accept(":", status)) {
    decl.type_start = index(status);
    decl.type = parse_type(status);
  }
  if (accept("=", status)) {
    decl.value = parse_expression(status);
  }

  // Check type or value has been set
  if (!decl.type.name && !decl.value) {
    status.errors.push({
      message: `Expected type or default value`,
      start: decl.start + decl.declaration.length + 1,
    });
  }

  // TODO: Move this into add_to_parent somehow
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func":
    case "for":
    case "while":
    case "branch": {
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

function parse_struct(visibility: "def" | "pub" | "sec", status: ParseStatus) {
  const start = index(status);
  accept(visibility, status);
  accept("struct", status);
  const name = consume(status);
  const struct = new StructNode(start, visibility, name);

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
    const func = new FunctionNode(-1, visibility, "init", new Type(struct.name));
    func.params = struct.fields
      .filter((f) => f.visibility !== "sec" && !f.value)
      .map((f) => new ParameterNode(-1, f.name, f.type));
    struct.functions.unshift(func);

    add_to_parent(struct, "Struct", status);
  }
}

function parse_trait(visibility: "def" | "pub" | "sec", status: ParseStatus) {
  const start = index(status);
  accept(visibility, status);
  accept("trait", status);
  const name = consume(status);
  const trait = new TraitNode(start, visibility, name);

  if (expect("{", status)) {
    status.stack.push(trait);
    parse_statement(status);
    expect("}", status);
    status.stack.pop();

    add_to_parent(trait, "Trait", status);
  }
}

function parse_function(visibility: "def" | "pub" | "sec", status: ParseStatus) {
  const start = index(status);
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
        func.return_type_start = index(status);
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
  const param = new ParameterNode(index(status), "");
  func.params.push(param);

  // Parameter name
  param.name = consume(status);

  // Parameter type
  if (accept(":", status)) {
    param.type_start = index(status);
    param.type = parse_type(status);
  }

  // Parameter value
  if (accept("=", status)) {
    param.default_value_start = index(status);
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

function parse_if_else(status: ParseStatus): IfElseNode | null {
  const if_start = index(status);
  accept("if", status);
  const condition = parse_expression(status);
  const short_if = accept("=>", status, false);
  if (short_if || expect("{", status)) {
    const if_branch = new BranchNode(index(status));
    const if_else = new IfElseNode(if_start, condition, if_branch);

    status.stack.push(if_else);
    status.stack.push(if_branch);
    if (short_if) {
      parse_return(status);
    } else {
      parse_statement(status);
    }

    if (accept("else", status)) {
      if ((short_if && expect("=>", status, false)) || (!short_if && expect("{", status))) {
        const else_branch = new BranchNode(index(status));
        if_else.else_branch = else_branch;

        status.stack.push(else_branch);
        if (short_if) {
          parse_return(status);
        } else {
          parse_statement(status);
        }
        status.stack.pop();
      }
    }

    if (!short_if) {
      expect("}", status);
    }

    status.stack.pop();
    status.stack.pop();

    return if_else;
  }

  return null;
}

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
      const for_loop = new ForLoopNode(for_start, item, list);

      status.stack.push(for_loop);
      parse_statement(status);
      expect("}", status);
      status.stack.pop();

      add_to_parent(for_loop, "For loop", status);
    }
  }
}

function parse_while_loop(status: ParseStatus) {
  const while_start = index(status);
  accept("while", status);
  const condition = parse_expression(status);
  if (expect("{", status)) {
    const while_loop = new WhileLoopNode(while_start, condition);

    status.stack.push(while_loop);
    parse_statement(status);
    expect("}", status);
    status.stack.pop();

    add_to_parent(while_loop, "While loop", status);
  }
}

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

function parse_break_or_continue(name: "break" | "continue", status: ParseStatus) {
  const description = name.substring(0, 1).toUpperCase() + name.substring(1);

  const node_start = index(status);
  accept(name, status);

  const node = name === "break" ? new BreakNode(node_start) : new ContinueNode(node_start);
  add_to_parent(node, `${description} statement`, status);
}

function parse_panic_or_todo(name: "panic" | "todo", status: ParseStatus) {
  const description = name.substring(0, 1).toUpperCase() + name.substring(1);

  const node_start = index(status);
  accept(name, status);

  const message_start = index(status);
  let message = peek_current(status);
  if (message && message.startsWith('"') && message.endsWith('"')) {
    message = consume(status).substring(1, message.length - 1);
  } else {
    status.errors.push({
      message: `Expected a ${name} message`,
      start: message_start,
    });
  }

  const node =
    name === "panic" ? new PanicNode(node_start, message) : new TodoNode(node_start, message);
  add_to_parent(node, `${description} statement`, status);

  // TODO: Ignore requirements for this branch

  // Go up the stack looking for a returning node
  let func: ReturningNode | null = null;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (isReturningNode(status.stack[i])) {
      func = status.stack[i] as ReturningNode;
      break;
    }
  }

  if (func) {
    func.has_return = true;
  }
}

function parse_return(status: ParseStatus) {
  const start = index(status);
  accept("return", status);
  // TODO: Allow this anywhere?
  accept("=>", status);
  const value = parse_expression(status);
  const ret = new ReturnNode(start, value);

  add_to_parent(ret, "Return statement", status);

  // Go up the stack looking for a returning node
  let func: ReturningNode | null = null;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (isReturningNode(status.stack[i])) {
      func = status.stack[i] as ReturningNode;
      break;
    }
  }

  if (func) {
    func.has_return = true;
  } else {
    status.errors.push({
      message: "Return must be inside an expression",
      start: index(status),
    });
  }
}

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
      invoke.type = new Type(source_name);
      invoke.static = true;
    }
    if (peek_current(status) !== ")") {
      parse_invocation_parameter(invoke, status);
    }
    expect(")", status);
    return invoke;
  } else {
    return new AccessFieldNode(start, name);
  }
}

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

function consume(status: ParseStatus, advance = true): string {
  if (status.i < status.tokens.length) {
    const result = status.tokens[status.i].value;
    status.i += advance ? 1 : 0;
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

function accept(value: string, status: ParseStatus, advance = true): boolean {
  if (status.i < status.tokens.length) {
    if (status.tokens[status.i].value == value) {
      status.i += advance ? 1 : 0;
      return true;
    }
  }
  return false;
}

function expect(value: string, status: ParseStatus, advance = true): boolean {
  if (status.i < status.tokens.length) {
    if (status.tokens[status.i].value == value) {
      status.i += advance ? 1 : 0;
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

function add_to_parent(node: BaseNode, description: string, status: ParseStatus): boolean {
  const parent = status.stack.at(-1)!;
  if (isBlockNode(parent)) {
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
