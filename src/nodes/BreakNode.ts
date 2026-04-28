import BaseNode from "./BaseNode.ts";

export default class BreakNode extends BaseNode {
	constructor(start: number) {
		super("break", start);
	}
}
