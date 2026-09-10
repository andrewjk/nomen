import BaseNode from "./BaseNode.ts";

export default class BitsetNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	cases: string[];
	/** True when this bitset is defined in the appended System library source. */
	is_library?: boolean;
	/**
	 * True when declared with the `must_use` modifier (`pub must_use bitset Flags`).
	 * Mirrors EnumNode.must_use: a statement-position call whose result type is
	 * a must_use bitset is a compile error. Callers must bind the value (e.g.
	 * `var _ = f.flags()`) or use it.
	 */
	must_use?: boolean;

	constructor(start: number, visibility: "pub" | "private", name: string, cases?: string[]) {
		super("bitset", start);
		this.visibility = visibility;
		this.name = name;
		this.cases = cases || [];
	}
}
