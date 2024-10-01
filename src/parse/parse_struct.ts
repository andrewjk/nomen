import FunctionNode from "../nodes/FunctionNode";
import ParameterNode from "../nodes/ParameterNode";
import StructNode from "../nodes/StructNode";
import Type from "../nodes/Type";
import type ParseStatus from "./ParseStatus";
import parse_statement from "./parse_statement";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";

export default function parse_struct(
  visibility: "inherit" | "pub" | "mod" | "private",
  status: ParseStatus,
) {
  const start = get_index(status);
  accept(visibility, status);
  accept("struct", status);
  const name = consume(status);
  const struct = new StructNode(start, visibility, name);

  // Bump the namespace
  const old_namespace = status.namespace;
  status.namespace += `.${name}`;

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
      .filter((f) => f.visibility !== "private" && !f.value)
      .map((f) => new ParameterNode(-1, f.name, f.type));
    struct.functions.unshift(func);

    add_to_parent(struct, "Struct", status);
  }

  status.namespace = old_namespace;
}
