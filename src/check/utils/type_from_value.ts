import Type from "../../nodes/Type";
import type CheckStatus from "../CheckStatus";

export default function type_from_value(value: string, status: CheckStatus): Type {
  const decl_value = status.values.find((v) => v.name === value);
  if (decl_value) {
    return decl_value.type;
  } else if (value === "true" || value === "false") {
    return new Type("bool");
  } else if (value.startsWith('"') && value.endsWith('"')) {
    return new Type("string");
  } else if (/^\d+$/.test(value)) {
    return new Type("int");
  } else {
    return new Type("");
  }
}
