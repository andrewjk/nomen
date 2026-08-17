import BaseNode from "./BaseNode.ts";
import ParameterNode from "./ParameterNode.ts";

export default class EnumNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	cases: { name: string; params: ParameterNode[] }[];
	/** True when this enum is defined in the appended System library source. */
	is_library?: boolean;
	/** Type parameter names (e.g. ["T", "E"] in `enum Result<T, E>`). */
	type_params: string[];
	/** True when type_params is non-empty (set during check). */
	is_generic?: boolean;

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
		this.type_params = [];
	}

	get has_associated_data(): boolean {
		return this.cases.some((c) => c.params.length > 0);
	}
}
