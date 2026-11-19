import BaseNode from "./BaseNode.ts";
import ParameterNode from "./ParameterNode.ts";

/**
 * One `case` declaration parsed inside an enum-body pragma arm —
 * `#for c of META.info(Shape).cases { case #{c.name} }` (the stage-6
 * iterable follow-up). `name` is "" at parse time when spelled as a
 * `comptime_name` template; the enum's expansion resolves it and pushes
 * the case into `EnumNode.cases` (as a plain `{ name, params }` entry).
 * A node surviving to check is a loud error — expansion consumes every
 * one.
 */
export default class EnumCaseDeclNode extends BaseNode {
	name: string;
	comptime_name?: string;
	params: ParameterNode[];

	constructor(start: number, name: string, params: ParameterNode[] = []) {
		super("enum_case_decl", start);
		this.name = name;
		this.params = params;
	}
}
