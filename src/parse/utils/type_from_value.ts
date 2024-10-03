import Type from "../../nodes/Type";
import type ParseStatus from "../ParseStatus";

export default function type_from_value(value: string, status: ParseStatus): Type {
  if (value === "true" || value === "false") {
    return new Type("bool", true);
  } else if (value.startsWith('"') && value.endsWith('"')) {
    return new Type("string", true);
  } else if (/^\d+$/.test(value)) {
    return new Type("int", true);
  } else {
    return new Type("");
  }
}
