import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class ValueNode extends BaseNode {
	value: string;
	type: Type;

	constructor(start: number, value: string, type?: Type) {
		super("value", start);
		this.value = value;
		this.type = type || type_from_value(value);
	}
}

// HACK: This is duplicated in too many places
function type_from_value(value: string): Type {
	if (value === "true" || value === "false") {
		return new Type("bool", true);
	} else if (value.startsWith('"') && value.endsWith('"')) {
		return new Type("string", true);
	} else if (value.startsWith("'") && value.endsWith("'")) {
		return new Type("char", true);
	} else if (/^(\+|-)*\d+$/.test(value)) {
		return new Type("int", true);
	} else if (/^(\+|-)*\d+.\d+$/.test(value)) {
		return new Type("float", true);
	} else {
		return new Type("");
	}
}
