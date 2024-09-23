import type BlockNode from "../nodes/BlockNode";
import DeclarationNode from "../nodes/DeclarationNode";
import StructNode from "../nodes/StructNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import parse_type from "./parse_type";
import accept from "./utils/accept";
import consume from "./utils/consume";
import get_index from "./utils/get_index";

export default function parse_declaration(
  visibility: "def" | "pub" | "sec",
  declaration: "const" | "var",
  status: ParseStatus,
) {
  const start = get_index(status);
  accept(visibility, status);
  const decl = new DeclarationNode(start, visibility, declaration, "");

  accept(declaration, status);
  decl.name_start = get_index(status);
  decl.name = consume(status);
  if (accept(":", status)) {
    decl.type_start = get_index(status);
    decl.type = parse_type(status);
  }
  if (accept("=", status)) {
    decl.value = parse_expression(status);
  }

  // Check type or value has been set
  if (!decl.type.name && !decl.value) {
    status.errors.push({
      message: `Expected type or default value`,
      start: decl.start + decl.declaration.length + 1,
    });
  }

  // TODO: Move this into add_to_parent somehow
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func":
    case "for":
    case "while":
    case "branch": {
      (parent as BlockNode).statements.push(decl);
      break;
    }
    case "trait":
    case "struct": {
      (parent as StructNode).fields.push(decl);
      break;
    }
    default: {
      status.errors.push({
        message: "Declaration cannot appear here",
        start: decl.start,
      });
    }
  }
}
