import BaseNode from "./BaseNode.ts";
import FunctionNode from "./FunctionNode.ts";

/**
 * An `extend struct Name { ... }` / `extend class Name { ... }` declaration.
 *
 * Adds methods (the `functions` below) to an already-declared struct/class
 * named `name`. The check phase merges `functions` into the target struct's
 * own `functions` array, after which they behave identically to methods
 * declared inside the original body — same dispatch, same visibility, same
 * codegen (`<Struct>_<method>`).
 *
 * Only methods may be added. Fields would change the type's layout, which a
 * value-type language cannot do out of line.
 *
 * `name` mirrors `StructNode.name` so the `self` / `ref self` parameter
 * parsing (which casts the parent to `StructNode`) resolves the receiver
 * type without special-casing.
 */
export default class ExtendNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	is_class: boolean;
	functions: FunctionNode[] = [];
	/** The struct this extend was merged into (set during the check gather). */
	scope?: BaseNode;

	constructor(start: number, visibility: "pub" | "private", name: string, is_class = false) {
		super("extend", start);
		this.visibility = visibility;
		this.name = name;
		this.is_class = is_class;
	}
}
