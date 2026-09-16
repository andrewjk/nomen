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
	/**
	 * The source-level name when `name` was rewritten to a scope-unique
	 * emission label (see `assign_type_label` in check_block_node). Undefined
	 * for top-level bitsets, whose source name IS their emission name.
	 */
	source_name?: string;

	constructor(start: number, visibility: "pub" | "private", name: string, cases?: string[]) {
		super("bitset", start);
		this.visibility = visibility;
		this.name = name;
		this.cases = cases || [];
	}
}
