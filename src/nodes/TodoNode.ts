import BaseNode from "./BaseNode.ts";

export default class TodoNode extends BaseNode {
	message: string;

	constructor(start: number, message?: string) {
		super("todo", start);
		this.message = message || "";
	}
}
