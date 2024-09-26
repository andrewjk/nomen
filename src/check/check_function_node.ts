import FunctionNode from "../nodes/FunctionNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_block_node from "./check_block_node";
import check_function_parameter_node from "./check_function_parameter_node";
import check_type_exists from "./utils/check_type_exists";

export default function check_function_node(func: FunctionNode, status: CheckStatus) {
  const old_values = status.values;

  for (let param of func.params) {
    check_function_parameter_node(param, status);
  }

  if (func.return_type.name) {
    if (!check_type_exists(func.return_type, status, func.return_type_start!)) {
      // Set the return type to the unknown type so that returns won't get checked
      func.return_type = new Type("?");
    }
  }

  status.functions.push(func);

  check_block_node(func, status);

  status.values = old_values;
}
