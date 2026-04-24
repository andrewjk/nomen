import TraitNode from "../nodes/TraitNode";
import type ParseStatus from "./ParseStatus";
import parse_statement from "./parse_statement";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";

export default function parse_trait(
  visibility: "inherit" | "pub" | "mod" | "priv",
  status: ParseStatus,
) {
  const start = get_index(status);
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
