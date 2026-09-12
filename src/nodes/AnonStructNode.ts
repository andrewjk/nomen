import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class AnonStructNode extends BaseNode {
	fields: { name: string; value: BaseNode; type?: Type }[];
	// `[ .. <base-expr>, field = value, ... ]`: a struct literal seeded from a
	// base expression (constructor call, factory call, or plain value). The
	// checker resolves the base to a value struct, validates the fields
	// against it, and stamps `type`; constructor-call bases are rewritten to
	// the ctor call with `field_overrides` (the `+`-form pipeline).
	base?: BaseNode;
	type?: Type;

	constructor(start: number, fields: { name: string; value: BaseNode }[]) {
		super("anon_struct", start);
		this.fields = fields;
	}
}
