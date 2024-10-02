import Type from "../../nodes/Type";
import type ParseStatus from "../ParseStatus";

export default function type_from_value(value: string, status: ParseStatus): Type {
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
