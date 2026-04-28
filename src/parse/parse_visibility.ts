import add_error from "../add_error.ts";
import parse_declaration from "./parse_declaration.ts";
import parse_function from "./parse_function.ts";
import parse_op from "./parse_op.ts";
import parse_struct from "./parse_struct.ts";
import parse_trait from "./parse_trait.ts";
import type ParseStatus from "./ParseStatus.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";
import peek_next from "./utils/peek_next.ts";

export default function parse_visibility(visibility: "pub" | "priv", status: ParseStatus) {
  // Declarations, funcs, structs and traits can have their visibility controlled
  // Visibility options are `pub`, `mod` and `sec`
  // `pub` is visible within the module and from other modules
  // `mod` is visible within the module only
  // `priv` is visible within the scope (e.g. function, folder) only
  // Declarations, funcs, structs and traits have `mod` visibility by default
  // Visibility and scope flow downwards, unless overridden to be more restrictive
  // TODO: Folder based namespaces??
  // Anything in the current folder has access to anything else
  // Anything in the current module has access to anything with `mod` visibility via `use`
  // Anything in other modules has access to anything with `pub` visibility via `use`
  const next = peek_next(status);
  switch (next) {
    case "const":
    case "var": {
      if (visibility === "priv" && status.stack.at(-1)?.node_type === "trait") {
        add_error(status, `Trait fields cannot be priv`, get_index(status));
        consume(status);
      } else {
        parse_declaration(visibility, next, status);
      }
      break;
    }
    case "struct": {
      parse_struct(visibility, status);
      break;
    }
    case "trait": {
      parse_trait(visibility, status);
      break;
    }
    case "func": {
      if (visibility === "priv" && status.stack.at(-1)?.node_type === "trait") {
        add_error(status, `Trait functions cannot be priv`, get_index(status));
        consume(status);
      } else {
        parse_function(visibility, status);
      }
      break;
    }
    case "op": {
      if (visibility === "priv" && status.stack.at(-1)?.node_type === "trait") {
        add_error(status, `Trait operators cannot be priv`, get_index(status));
        consume(status);
      } else {
        parse_op(visibility, status);
      }
      break;
    }
    default: {
      add_error(
        status,
        `Visibility can only be set for const, var, struct, trait or func`,
        get_index(status),
      );
      consume(status);
    }
  }
}
