import RawNode from "../nodes/RawNode";
import type ParseStatus from "./ParseStatus";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";

export default function parse_raw(status: ParseStatus) {
  const start = get_index(status);
  accept("raw", status);
  /*
  if (expect("{", status)) {
    let value: string[] = [];
    let depth = 0;
    while (true) {
      if (accept("{", status)) {
        depth += 1;
      } else if (accept("}", status)) {
        if (depth === 0) {
          break;
        } else {
          depth -= 1;
        }
      }
      value.push(consume(status));
    }

    const raw = new RawNode(start, value.join(" "));
    add_to_parent(raw, "Raw C", status);
  }
    */

  const value = consume(status);
  const raw = new RawNode(start, value);
  add_to_parent(raw, "Raw C", status);
}
