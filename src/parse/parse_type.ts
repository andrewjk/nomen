import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

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
