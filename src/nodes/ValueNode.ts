import { is_int_literal } from "../int_literal.ts";
import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class ValueNode extends BaseNode {
	value: string;
	type: Type;
	is_enum_shorthand?: boolean;
	type_args?: Type[];
	/**
	 * Stamped (non-enumerably, via set_resolved_function) when this value is
	 * a function referenced as a VALUE and the callee is nested inside
	 * another body: the build emits its emission label, not the bare source
	 * name. Mirrors FunctionCallNode.resolved_function.
	 */
	resolved_function?: import("./FunctionNode.ts").default;
	/**
	 * Stamped by the literal-element last-use pass (stamp_literal_element_moves):
	 * this bare variable is a bracket-literal element (`[t, c]`) at its last
	 * use, so the checker's tuple-element ownership rule treats it as an
	 * inferred `move` (ownership transfers; the source's cleanup is
	 * suppressed) instead of rejecting the aliasing copy.
	 */
	literal_last_use_move?: boolean;

	constructor(start: number, value: string, type?: Type) {
		super("value", start);
		this.value = value;
		this.type = type || type_from_value(value);
	}
}

// HACK: This is duplicated in too many places
function type_from_value(value: string): Type {
	if (value === "null") {
		return new Type("null", true);
	} else if (value === "true" || value === "false") {
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
