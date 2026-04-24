import add_error from "../add_error";
import FunctionNode from "../nodes/FunctionNode";
import OperationNode from "../nodes/OperationNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_operation_node(op: OperationNode, status: CheckStatus): boolean {
  const result = check_node(op.left_value, status) && check_node(op.right_value, status);
  if (!result) {
    return false;
  }

  const left_type = type_from_value_node(op.left_value, status);
  const right_type = type_from_value_node(op.right_value, status);

  // Check for custom operator on struct (including arrays, which use the Array struct)
  const custom_op = find_custom_operator(op, left_type, right_type, status);
  if (custom_op) {
    // For array types, preserve the element type in the result
    if (left_type.is_array && custom_op.return_type.name === "Array") {
      op.type = new Type(left_type.name);
      op.type.is_array = true;
    } else {
      op.type = custom_op.return_type;
    }
    op.operator_func = {
      struct_name: left_type.is_array ? "Array" : left_type.name,
      func_name: custom_op.name,
    };
    return true;
  }

  // If left operand is a non-simple struct and no custom operator was found, it's an error
  const struct_name = left_type.is_array ? "Array" : left_type.name;
  if (status.structs.find((s) => s.name === struct_name && !s.is_simple_type)) {
    add_error(
      status,
      `No operator ${op.op} defined for type ${struct_name}`,
      op.start,
    );
    return false;
  }

  check_type_and_value_match(
    left_type,
    right_type,
    value_from_value_node(op.right_value),
    status,
    op.right_value.start,
    "operation",
  );

  // HACK: this needs to come from operator funcs for each operator and type combination
  switch (op.op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "%": {
      //op.type = new Type("int");
      op.type = left_type;
      break;
    }
    case "==":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=":
    case "&&":
    case "||": {
      op.type = new Type("bool");
      break;
    }
    default: {
      add_error(status, `Unknown operator: ${op.op}`, op.start);
      return false;
    }
  }

  return true;
}

function find_custom_operator(
  op: OperationNode,
  left_type: Type,
  right_type: Type,
  status: CheckStatus,
): FunctionNode | undefined {
  // For array types, look up operators on the Array struct
  const struct_name = left_type.is_array ? "Array" : left_type.name;
  if (!struct_name) {
    return undefined;
  }

  const struct = status.structs.find((s) => s.name === struct_name);
  if (!struct) {
    return undefined;
  }

  const func_name = operator_to_func_name(op.op);
  if (!func_name) {
    return undefined;
  }

  const func = struct.functions.find((f) => f.name === func_name);
  if (!func) {
    return undefined;
  }

  // Validate that the function has a non-self parameter matching the right operand type
  const non_self_params = func.params.filter((p) => !p.is_self_param);
  if (non_self_params.length !== 1) {
    add_error(
      status,
      `Operator function ${func_name} must take exactly one parameter (plus self)`,
      op.start,
    );
    return undefined;
  }

  const other_param = non_self_params[0];
  // For array operators, Array struct parameters accept any array type
  const param_type = other_param.type;
  if (param_type.name === "Array" && !param_type.is_array && right_type.is_array) {
    // Array struct parameter matches any array type
  } else {
    check_type_and_value_match(
      param_type,
      right_type,
      value_from_value_node(op.right_value),
      status,
      op.right_value.start,
      "param",
    );
  }

  return func;
}

function operator_to_func_name(op: string): string | undefined {
  switch (op) {
    case "+":
      return "add";
    case "-":
      return "sub";
    case "*":
      return "mul";
    case "/":
      return "div";
    default:
      return undefined;
  }
}
