import Type from "../../nodes/Type.ts";

export default function type_name(type: Type) {
  return `${type.name}${type.is_array ? `[]` : ""}`;
}
