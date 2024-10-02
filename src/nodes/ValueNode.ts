import BaseNode from "./BaseNode";
import Type from "./Type";

export default class ValueNode extends BaseNode {
  value: string;
  type: Type;

  constructor(start: number, value: string, type?: string | Type) {
    super("value", start);
    this.value = value;
    //this.type = typeof type === "string" ? new Type(type) : type || new Type("");
    if (typeof type === "string") {
      this.type = new Type(type);
    } else if (type) {
      this.type = type;
    } else {
      this.type = type_from_value(value);
    }
  }
}

// HACK: This is duplicated in too many places
function type_from_value(value: string): Type {
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
