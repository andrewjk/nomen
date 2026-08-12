import BaseNode from "./BaseNode.ts";
import ParameterNode from "./ParameterNode.ts";
import Type from "./Type.ts";

export default class DeclarationNode extends BaseNode {
	visibility: "pub" | "private";
	declaration: "const" | "var" | "mov" | "view";
	name: string;
	type: Type;
	value?: BaseNode;
	constraint?: BaseNode;
	name_start?: number;
	type_start?: number;
	func_params?: ParameterNode[];
	func_return_type?: Type;
	scope?: BaseNode;
	/** Optional swap replacement for `var X b = mov obj.field swap <expr>`: the
	 *  expression stored back into the moved-out field to revalidate it. */
	swap?: BaseNode;
	/** True for the synthesized loop-iterator binding (`var <item> = arr.at(i)`)
	 *  the for-of desugaring prepends to the loop body. It is rebound every
	 *  iteration by the loop, not by user code, so the `var`-never-changed
	 *  warning must not fire for it. */
	is_loop_iterator?: boolean;
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
	constructor(
		start: number,
		visibility: "pub" | "private",
		declaration: "const" | "var" | "mov" | "view",
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
