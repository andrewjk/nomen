import Type from "../../nodes/Type";
import type CheckStatus from "../CheckStatus";

export default function type_from_value(value: string, status: CheckStatus): Type {
  // Is it a value that's been declared in a var/const or param?
  const decl_value = status.values.find((v) => v.name === value);
  if (decl_value) {
    return decl_value.type;
  }

  // Is it a struct?
  const struct_value = status.structs.find((s) => s.name === value);
  if (struct_value) {
    // NOTE: Maybe we should be storing this type on the struct?
    return new Type(struct_value.name);
  }

  if (value === "true" || value === "false") {
    return new Type("bool");
  } else if (value.startsWith('"') && value.endsWith('"')) {
    return new Type("string");
  } else if (/^\d+$/.test(value)) {
    return new Type("int");
  } else {
    return new Type("");
  }
}
