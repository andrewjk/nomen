import ArrayValuesNode from "../nodes/ArrayValuesNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import accept from "./utils/accept";

export default function parse_array_value(array: ArrayValuesNode, status: ParseStatus) {
  // Get this value
  const value = parse_expression(status);
  array.values.push(value);

  // Maybe get another value
  if (accept(",", status)) {
    parse_array_value(array, status);
  }
}
