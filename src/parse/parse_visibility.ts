import type ParseStatus from "./ParseStatus";
import parse_declaration from "./parse_declaration";
import parse_function from "./parse_function";
import parse_struct from "./parse_struct";
import parse_trait from "./parse_trait";
import consume from "./utils/consume";
import get_index from "./utils/get_index";
import peek_next from "./utils/peek_next";

export default function parse_visibility(visibility: "pub" | "sec", status: ParseStatus) {
  // All code is internal by default
  // Anything in the current package has access to anything else
  // Although it has to be imported if it is in another file
  // You can add `pub` to declarations, structs, traits and funcs to make them public (i.e. accessible from other packages)
  // You can add `sec` to declarations, structs, traits and funcs to make them secret (i.e. cannot be accessed from other scopes)
  // Initializers inherit the visibility of their struct
  // Struct and trait declarations and functions do not inherit the visibility of their parent -- you must set `pub` or `sec` for each field
  const next = peek_next(status);
  switch (next) {
    case "const":
    case "var": {
      if (visibility === "sec" && status.stack.at(-1)?.node_type === "trait") {
        status.errors.push({
          message: `Trait fields cannot be secret`,
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
      if (visibility === "sec" && status.stack.at(-1)?.node_type === "trait") {
        status.errors.push({
          message: `Trait functions cannot be secret`,
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
