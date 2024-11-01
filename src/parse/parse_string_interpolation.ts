import type_from_value_node from "../check/utils/type_from_value_node";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode";
import AccessNode from "../nodes/AccessNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import Type from "../nodes/Type";
import ValueNode from "../nodes/ValueNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import accept from "./utils/accept";
import consume from "./utils/consume";
import get_index from "./utils/get_index";

// TODO: This should actually be calling a standard String.interpolate method with a params array

export default function parse_string_interpolation(status: ParseStatus): FunctionCallNode {
  const start = get_index(status);

  let pattern = consume(status);
  let values = [];

  while (true) {
    const value = consume(status);
    if (value === "\\{") {
      pattern += "\\{}";
      let param = parse_expression(status);
      // TODO: Not if it's already a string
      param = new AccessNode(
        start,
        param,
        new AccessFunctionCallNode(start, "to_string" /*, new Type("string", true)*/),
      );
      //console.log("PARAM", param);
      values.push(param);
      accept("}", status);
    } else if (value.endsWith('"')) {
      pattern += value;
      break;
    } else {
      pattern += value;
    }
  }

  // HACK: This should be done in build
  pattern = pattern.replaceAll("\\{}", "%s");

  return new FunctionCallNode(start, `_string_interpolate_${values.length}`, new Type("string"), [
    new ValueNode(0, pattern, new Type("string", true)),
    ...values,
  ]);
}
