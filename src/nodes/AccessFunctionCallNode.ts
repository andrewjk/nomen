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
	 * Indices of `mv` arguments whose callee parameter takes ownership of a
	 * byte-copied (boxed) value — STRUCT_PLAN_3 B4: a value-struct conformer
	 * argument to a `mv Trait` parameter. The box owns the transferred
	 * string records, so the build drops the donor's records WITHOUT freeing
	 * (mirrors FunctionCallNode.move_owned_param_indices).
	 */
	move_owned_param_indices?: number[];
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
	/**
	 * The in-place construction guarantee (docs: in-place push): the index
	 * of the single `mv T value` argument that is a direct call of type T —
	 * the backends reserve the container's new slot (`List_reserve`) and
	 * construct the argument call's result directly into it, instead of
	 * materializing a `_param_N` temp and copying it at the store. Set by
	 * check_function_call only when the whole shape is provably lowerable
	 * (bare local receiver, side-call-free argument arguments, string or
	 * value-struct element — see build_common/in_place_push.ts); both
	 * backends re-derive the mechanical facts through that shared helper, so
	 * the checker's stamp and the lowers can't drift.
	 */
	in_place_push_index?: number;
	/**
	 * The in-place STORE siblings (item: `set`/`insert`/`add`/`alloc`): which
	 * slot primitive the in-place store lowering calls, when
	 * `in_place_push_index` stamps a `set` call's value argument.
	 * `"slot_ptr"` — a `List`/`Buffer`-shaped container whose `slot_ptr(i)`
	 * addresses element `i`; the splice reclaims the displaced value through
	 * the slot address itself. `"set_slot_ptr"` — a `Map`-shaped container
	 * whose `set_slot_ptr(key)` runs the whole set preamble + probe + insert
	 * bookkeeping (or the displaced reclaim) and returns the value slot.
	 * Stamped by check_function_call; both backends branch on the kind to
	 * pick the primitive.
	 */
	in_place_store_kind?: "slot_ptr" | "set_slot_ptr";
	/**
	 * In-place push, donor form: the argument is a bare `mv p` whose
	 * declaration (`var p = <call of T>`) is the IMMEDIATELY preceding
	 * statement and whose only use in the function is this push — the
	 * declaration constructs its initializer directly into the fresh slot
	 * and THIS statement lowers to just the length bump. Stamped by
	 * check_function_call; the declaration carries the mirror stamp
	 * (`DeclarationNode.in_place_push_slot`).
	 */
	in_place_donor_name?: string;
	/**
	 * The in-place construction guarantee, enum-payload tranche (PERF_PLAN
	 * item 7): indices of this enum case construction's arguments that are
	 * direct calls of the payload type — the case store builds each stamped
	 * argument straight into its payload slot (the x0/x1 pair store, or the
	 * sret preset window against the payload's frame address) instead of
	 * hoisting a `_param_N` temp and strdup/struct-copying it in. Stamped by
	 * the checker only when the whole shape is provably lowerable (every
	 * string payload of the case is such a call — the C take-variant claims
	 * all of them; see check/utils/enum_mono.ts,
	 * stamp_in_place_enum_payloads). Both backends re-derive the mechanical
	 * facts at the site, so the stamp and the lowering can't drift.
	 */
	in_place_payload_indices?: number[];
	variadic_param_index?: number;
	mangled_name?: string;
	/**
	 * Set during checking when the called method has a `mv out T` return — the
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
	 * Set during checking when this `.on_<event>(closure)` call was
	 * checker-interpreted as a handler registration (docs/HANDLERS.md): the
	 * closure body was hoisted into a hidden method on the enclosing struct
	 * and the site checked into a dispatch arm on the host's synthesized
	 * `handle_clicks`. The registration itself emits NO code — both backends
	 * return as soon as they see the stamp.
	 */
	is_handler_registration?: boolean;
	/**
	 * Set during checking when this `.on_<event>(closure)` call was
	 * checker-interpreted as a COMPOSITE EVENT registration (docs/HANDLERS.md
	 * Stage 3): the closure was hoisted into a hidden method on the app and
	 * the params were REWRITTEN to the enrollment call — `receiver.on_<event>(id)`
	 * — which resolves as the composite's own declared event API. The stamp
	 * makes the re-entered ordinary resolution skip the desugar hook.
	 */
	is_handler_enrollment?: boolean;
	/**
	 * Set during checking when a `ref T x = container.at(i)` binding was
	 * rewritten to the element-borrow primitive (`slot_ptr` — docs/HANDLERS.md
	 * Stage 4): the call RETURNS the slot pointer, so the ref-binding build
	 * emits it bare (no `&`).
	 */
	is_element_slot_load?: boolean;
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
