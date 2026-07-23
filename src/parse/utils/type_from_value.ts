import { is_int_literal } from "../../int_literal.ts";
import Type from "../../nodes/Type.ts";

export default function type_from_value(value: string): Type {
	if (value === "true" || value === "false") {
		return new Type("bool", true);
	} else if (value.startsWith('"') && value.endsWith('"')) {
		return new Type("string", true);
	} else if (value.startsWith("'") && value.endsWith("'")) {
		return new Type("char", true);
	} else if (is_int_literal(value)) {
		return new Type("int", true);
	} else if (/^(\+|-)*\d+.\d+$/.test(value)) {
		return new Type("float", true);
	} else {
		return new Type("");
	}
}
