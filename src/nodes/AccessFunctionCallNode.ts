import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class AccessFunctionCallNode extends BaseNode {
	name: string;
	type: Type;
	params: BaseNode[];

	is_static?: boolean;
	ref_param_indices?: number[];
	mov_param_indices?: number[];
	/**
	 * Indices of arguments whose corresponding callee parameter is a nullable
	 * struct value type (`T?` where T is a non-class struct). See
	 * FunctionCallNode.nullable_param_indices.
	 */
	nullable_param_indices?: number[];
	/**
	 * Indices of arguments whose corresponding callee parameter is a `view T`
	 * (notably `view string`). See FunctionCallNode.view_param_indices.
	 */
	view_param_indices?: number[];
	swap_params?: Map<number, BaseNode>;
	variadic_param_name?: string;
	variadic_param_index?: number;
	mangled_name?: string;
	/**
	 * Set during checking when the called method has a `mov out T` return — the
	 * call produces an owned value (not a borrow), so the caller must anchor and
	 * free it. Read by the borrow checker (treats the result as non-borrowed)
	 * and the build (anchors the result).
	 */
	owned_return?: boolean;
	/**
	 * Bounds inferred from the call's return contract (`out TYPE: out < X`),
	 * resolved to the caller's receiver path. Populated during checking so that
	 * when this call is used as an argument (e.g. `g.at(g.edge_target(e))`), the
	 * outer call's parameter constraint can verify against the returned value.
	 */
	return_bounds?: {
		upper: string[];
		lower: string[];
		upper_inclusive: string[];
		lower_inclusive: string[];
	};
	/**
	 * A compile-time length derived from the call's return contract
	 * (`out Array<T>: out.length == N`), when N is a literal. Consumed by the
	 * array method-call type transform to set the result type's `.length` so
	 * the build's inline `to_string` paths fire. Stored as a string.
	 */
	inferred_array_length?: string;
	/**
	 * Set during checking when this is a `nursery.spawn(fn, args...)` escape-
	 * hatch call (target type is `Nursery`, method name is `spawn`). The build
	 * phase reads `function_return_type` and emits the spawn trampoline against
	 * the passed Nursery's runtime futures/count pointers. See ASYNC.md.
	 */
	is_nursery_spawn?: boolean;
	/**
	 * For `nursery.spawn`: the spawned function's return type, captured during
	 * checking (mirrors SpawnNode.function_return_type). Used by the build to
	 * decide whether the trampoline captures a result and to type the Task.
	 */
	function_return_type?: Type;
	/**
	 * For `nursery.spawn`: set by the build when the call appears as a
	 * top-level statement (its Task result is discarded). Mirrors
	 * SpawnNode.is_statement — fire-and-forget spawns skip Task allocation.
	 */
	is_statement?: boolean;
	/**
	 * Set when this `.at(i)` call was synthesized by array destructuring
	 * (`var [a, b] = arr`). The index is a compile-time constant chosen by
	 * the programmer, so the parameter constraint (bounds check) is skipped —
	 * the programmer is asserting the array is long enough positionally.
	 */
	skip_bounds_check?: boolean;

	constructor(start: number, name: string, type?: Type, params?: BaseNode[], is_static?: boolean) {
		super("access_func", start);
		this.name = name;
		this.type = type || new Type("");
		this.params = params || [];

		// HACK: For testing
		this.is_static = !!is_static;
	}
}
