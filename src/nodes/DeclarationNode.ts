import BaseNode from "./BaseNode.ts";
import ParameterNode from "./ParameterNode.ts";
import Type from "./Type.ts";

export default class DeclarationNode extends BaseNode {
	visibility: "pub" | "private";
	declaration: "const" | "var" | "move" | "view";
	name: string;
	type: Type;
	value?: BaseNode;
	constraint?: BaseNode;
	name_start?: number;
	type_start?: number;
	/** True when this top-level declaration is in the appended System library
	 * source. Set by mark_library_nodes; used to route root-scope globals
	 * (e.g. `const MAX_DIM`) to the correct TU in the System-lib split. */
	is_library?: boolean;
	func_params?: ParameterNode[];
	func_return_type?: Type;
	scope?: BaseNode;
	/** Optional swap replacement for `var X b = move obj.field swap <expr>`: the
	 *  expression stored back into the moved-out field to revalidate it. */
	swap?: BaseNode;
	/** True for the synthesized loop-iterator binding (`var <item> = arr.at(i)`)
	 *  the for-of desugaring prepends to the loop body. It is rebound every
	 *  iteration by the loop, not by user code, so the `var`-never-changed
	 *  warning must not fire for it. */
	is_loop_iterator?: boolean;
	/** Set by the build's move-on-last-use pass (STRING_PLAN tranche 4, see
	 *  check/utils/last_use.ts) when this declare is `var u = t` with t an
	 *  owned string local proven never read or written again: the backends
	 *  transfer the pair and the ownership mark instead of strdup'ing a copy.
	 *  Consumers must also honor the live kill-switch. */
	last_use_move?: boolean;
	/** True for a hoisted call-argument temp (`_param_N`) whose initializer is
	 *  an array literal but whose callee parameter is a heap `Array<T>` (the
	 *  monomorphized `Array_<T>` struct exists). The temp must be materialised
	 *  as a heap `Array_<T>` buffer (not a stack array) so the promoted
	 *  `struct Array_<T>*` parameter's `.length`/`.at`/`.set`/iteration see the
	 *  struct layout. Set at check time by check_function_call; consumed by the
	 *  build backends' declaration emitters. */
	is_heap_array_literal?: boolean;
	/** True for a hoisted call-argument temp (`_param_N`) that is a heap COPY
	 *  of a stack-array local, bound to a heap `Array<T>` param (non-`ref`).
	 *  `value` is the source ValueNode; the temp is materialised as a heap
	 *  `Array_<T>` buffer whose elements are copied from the source's inline
	 *  storage at build time. Set at check time by check_function_call;
	 *  consumed by the build backends' declaration emitters. */
	is_heap_array_copy?: boolean;
	/** Trait name for a trait-typed local whose concrete storage is a class
	 *  instance (`var Speaker s = Dog()`): the C backend reclaims it at scope
	 *  exit / reassignment through the `<Trait>_destroy` vtable shim. Carried
	 *  on THIS declaration rather than a body-global name map so a same-named
	 *  variable in a sibling or shadowing scope can never inherit the binding
	 *  (a stale name-keyed entry emitted `<Trait>_destroy(v)` for int/string
	 *  elements — invalid C). Set at build time by the C declaration builder;
	 *  consumed by build_auto_free and the reassignment path. */
	trait_class_trait?: string;
	/** Concrete struct name for a trait-typed local whose slot holds INLINE
	 *  value-struct storage (`var Rule r = HeadingV()`): copies of the slot
	 *  (`var Rule r2 = r`) must declare the SAME concrete struct — the trait
	 *  typedef is an empty struct and cannot hold the value. Carried on THIS
	 *  declaration (scope-correct, same rationale as trait_class_trait). Set
	 *  at build time by the C declaration builder; consumed when building
	 *  another declaration initialized from this variable. */
	trait_concrete_struct?: string;
	constructor(
		start: number,
		visibility: "pub" | "private",
		declaration: "const" | "var" | "move" | "view",
		name: string,
		type?: Type,
		value?: BaseNode,
	) {
		super("declare", start);
		this.visibility = visibility;
		this.declaration = declaration;
		this.name = name;
		this.type = type || new Type("");
		this.value = value;
	}
}
