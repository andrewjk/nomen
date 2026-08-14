import BaseNode from "./BaseNode.ts";
import ParameterNode from "./ParameterNode.ts";

export default class EnumNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	cases: { name: string; params: ParameterNode[] }[];
	/** True when this enum is defined in the appended System library source. */
	is_library?: boolean;

	constructor(
		start: number,
		visibility: "pub" | "private",
		name: string,
		cases?: { name: string; params: ParameterNode[] }[],
	) {
		super("enum", start);
		this.visibility = visibility;
		this.name = name;
		this.cases = cases || [];
	}

	get has_associated_data(): boolean {
		return this.cases.some((c) => c.params.length > 0);
	}
}
