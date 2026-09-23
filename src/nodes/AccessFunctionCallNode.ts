import BaseNode from "./BaseNode.ts";
import type FunctionNode from "./FunctionNode.ts";
import Type from "./Type.ts";

export default class AccessFunctionCallNode extends BaseNode {
	name: string;
	type: Type;
	params: BaseNode[];

	is_static?: boolean;
	/**
	 * `s.f(args)` where `f` is a func-typed FIELD (not a method): an indirect
	 * call through the field's stored code pointer. Set by check_access_node;
	 * the backends lower it as an indirect call (C casts the field to the
	 * signature, aarch64 loads it and `blr`s).
	 */
	is_func_field_call?: boolean;
	ref_param_indices?: number[];
	move_param_indices?: number[];
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
	 * Set during checking when the called method has a `move out T` return — the
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
	 * Set during checking when this is a `nursery.start(Thread(fn(args)))`
	 * escape-hatch call (target type is `Nursery`, method name is `start`).
	 * The build phase reads `function_return_type` and emits the spawn
	 * trampoline against the passed Nursery's runtime futures/count pointers.
	 * See ASYNC.md, "Nursery escape hatch".
	 */
	is_nursery_spawn?: boolean;
	/**
	 * RETIRED with the pre-migration launch dispatch: `.start()`/`.detach()`
	 * are ordinary methods on the library `Thread` class now (docs/ASYNC.md).
	 * The flags remain only because monomorphized clones can carry them from
	 * older stamps; nothing sets or consumes them on fresh checks.
	 */
	is_thread_start?: boolean;
	/** Retired — see is_thread_start. */
	is_thread_detach?: boolean;
	/** Retired — see is_thread_start. */
	is_fiber_start?: boolean;
	/**
	 * RETIRED with the pre-migration launch dispatch: `.start_on(buf)` is
	 * checker-validated and rewritten to the ordinary `Fiber.start` method
	 * (docs/ASYNC.md). Kept only for old clone stamps.
	 */
	is_fiber_start_on?: boolean;
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
	 * Set during checking when this `.to_string()` call sits at a BORROW
	 * position: a call argument whose parameter is a plain `string` (verified
	 * non-mutating by the interprocedural scan, see
	 * check/utils/string_mutation_scan.ts) or a string concat operand (a
	 * read-only consumer by construction). The backends then pass the
	 * receiver's (ptr, len) pair straight through — skipping the
	 * `string_to_string` strdup and the temporary's anchor/free — instead of
	 * materializing an owned copy nobody mutates.
	 */
	borrow_to_string?: boolean;
	/**
	 * Set when this `.at(i)` call was synthesized by array destructuring
	 * (`var [a, b] = arr`). The index is a compile-time constant chosen by
	 * the programmer, so the parameter constraint (bounds check) is skipped —
	 * the programmer is asserting the array is long enough positionally.
	 */
	skip_bounds_check?: boolean;
	/**
	 * The concrete FunctionNode the checker resolved this method call to.
	 * See FunctionCallNode.resolved_function — used by build-time passes for
	 * callee-signature facts (notably hidden string-length companions).
	 */
	resolved_function?: FunctionNode;

	constructor(start: number, name: string, type?: Type, params?: BaseNode[], is_static?: boolean) {
		super("access_func", start);
		this.name = name;
		this.type = type || new Type("");
		this.params = params || [];

		// HACK: For testing
		this.is_static = !!is_static;
	}
}
