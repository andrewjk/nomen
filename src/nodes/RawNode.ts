import BaseNode from "./BaseNode.ts";

export default class RawNode extends BaseNode {
	value: string;
	/**
	 * Companion-C dialect — `#raw("c")`. The block's text is C source compiled
	 * through the companion file on the aarch64 backend (the historic
	 * `aarch64_use_c` tag). An unmarked block is the target's DEFAULT dialect:
	 * inline assembly on aarch64, C on the C backend.
	 */
	is_c?: boolean;
	/**
	 * Emission scope — `#raw(…, "file")` hoists the block to file scope
	 * (companion file / headers) instead of splicing it at its statement.
	 */
	scope?: "block" | "file";

	constructor(start: number, value: string, is_c?: boolean, scope?: "block" | "file") {
		super("raw", start);
		this.value = value;
		this.is_c = is_c;
		this.scope = scope;
	}
}
