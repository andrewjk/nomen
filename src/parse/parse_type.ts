import Type from "../nodes/Type";
import ValueNode from "../nodes/ValueNode";
import type ParseStatus from "./ParseStatus";
import accept from "./utils/accept";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";
import peek_current from "./utils/peek_current";

export default function parse_type(status: ParseStatus): Type {
  const type = new Type(consume(status));
  if (accept("[", status)) {
    type.is_array = true;
    if (peek_current(status) !== "]") {
      // TODO: Should be parsing expression
      type.length = new ValueNode(get_index(status), consume(status));
    }
    expect("]", status);
  }
  return type;
}
