import type ParseStatus from "./ParseStatus";
import parse_declaration from "./parse_declaration";
import parse_function from "./parse_function";
import parse_struct from "./parse_struct";
import parse_trait from "./parse_trait";
import consume from "./utils/consume";
import get_index from "./utils/get_index";
import peek_next from "./utils/peek_next";

export default function parse_visibility(visibility: "pub" | "private", status: ParseStatus) {
  // Declarations, funcs, structs and traits can have their visibility controlled
  // Visibility options are `pub`, `mod` and `sec`
  // `pub` is visible within the module and from other modules
  // `mod` is visible within the module only
  // `private` is visible within the scope (e.g. function, folder) only
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
      if (visibility === "private" && status.stack.at(-1)?.node_type === "trait") {
        status.errors.push({
          message: `Trait fields cannot be private`,
          start: get_index(status),
        });
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
      if (visibility === "private" && status.stack.at(-1)?.node_type === "trait") {
        status.errors.push({
          message: `Trait functions cannot be private`,
          start: get_index(status),
        });
        consume(status);
      } else {
        parse_function(visibility, status);
      }
      break;
    }
    default: {
      status.errors.push({
        message: `Visibility can only be set for const, var, struct, trait or func`,
        start: get_index(status),
      });
      consume(status);
    }
  }
}
