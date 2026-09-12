import BaseNode from "./BaseNode.ts";
import type Type from "./Type.ts";

/**
 * A pointer element access, `p[index]`, inside an `unsafe` context.
 *
 * `target` must be a `ptr T` value; `index` is an integer offset in
 * ELEMENTS (each backend scales by the element's byte width). In an rvalue
 * position the node loads a `T`; as an assignment target it stores one.
 * Both forms are compile errors outside `unsafe` code.
 */
export default class IndexNode extends BaseNode {
	node_type = "index" as const;
	target: BaseNode;
	index: BaseNode;
	/** Element type `T`, stamped by the checker (read by the mono retype passes). */
	type?: Type;
	/**
	 * True when the target is a heap `Array<T>` (not a raw pointer): the
	 * element base differs per backend (C skips the struct header; aarch64's
	 * receiver is already the first element), so the backends lower the
	 * address computation differently.
	 */
	is_array_target?: boolean;

	constructor(start: number, target: BaseNode, index: BaseNode) {
		super("index", start);
		this.target = target;
		this.index = index;
	}
}
