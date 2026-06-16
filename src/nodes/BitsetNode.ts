import BaseNode from "./BaseNode.ts";

export default class BitsetNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	cases: string[];

	constructor(start: number, visibility: "pub" | "private", name: string, cases?: string[]) {
		super("bitset", start);
		this.visibility = visibility;
		this.name = name;
		this.cases = cases || [];
	}
}
