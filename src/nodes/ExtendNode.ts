import BaseNode from "./BaseNode.ts";
import FunctionNode from "./FunctionNode.ts";
import Type from "./Type.ts";

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
 * `extend struct Name: Trait1, Trait2 { ... }` additionally makes the target
 * conform to the listed traits out of line (Rust-style `impl Trait for Type`).
 * `traits` / `trait_args` mirror `StructNode` and are merged into the target
 * alongside `functions`, so conformance checking and vtable emission treat
 * them exactly like traits declared in the body.
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
	/** Trait names the target conforms to via this extend (out-of-line). */
	traits: string[] = [];
	/**
	 * Type arguments supplied for each conformance in `traits`, parallel to
	 * that array. `trait_args[i]` holds the args for `traits[i]`, or
	 * undefined when the conformance takes none. Mirrors StructNode.
	 */
	trait_args: (Type[] | undefined)[] = [];
	/** The struct this extend was merged into (set during the check gather). */
	scope?: BaseNode;

	constructor(start: number, visibility: "pub" | "private", name: string, is_class = false) {
		super("extend", start);
		this.visibility = visibility;
		this.name = name;
		this.is_class = is_class;
	}
}
