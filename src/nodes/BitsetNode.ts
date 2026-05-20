import BaseNode from "./BaseNode.ts";

export default class BitsetNode extends BaseNode {
	visibility: "inherit" | "pub" | "mod" | "priv";
	name: string;
	cases: string[];

	constructor(
		start: number,
		visibility: "inherit" | "pub" | "mod" | "priv",
		name: string,
		cases?: string[],
	) {
		super("bitset", start);
		this.visibility = visibility;
		this.name = name;
		this.cases = cases || [];
	}
}
