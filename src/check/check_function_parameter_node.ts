import ParameterNode from "../nodes/ParameterNode";
import type CheckStatus from "./CheckStatus";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import check_type_exists from "./utils/check_type_exists";
import type_from_value from "./utils/type_from_value";

export default function check_function_parameter_node(param: ParameterNode, status: CheckStatus) {
  if (param.type.name) {
    check_type_exists(param.type, status, param.type_start!);
  }

  if (param.default_value) {
    check_type_and_value_match(
      param.type,
      type_from_value(param.default_value, status),
      param.default_value,
      status,
      param.default_value_start!,
      "param default",
    );
    if (!param.type.name) {
      param.type = type_from_value(param.default_value, status);
    }
  }

  status.values.push({
    declaration: "const",
    name: param.name,
    type: param.type,
  });
}
