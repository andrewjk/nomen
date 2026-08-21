import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class FunctionCallNode extends BaseNode {
	name: string;
	type: Type;
	params: BaseNode[];

	is_static?: boolean;
	is_func_param?: boolean;
	type_args?: Type[];
	ref_param_indices?: number[];
	mov_param_indices?: number[];
	/**
	 * Indices of arguments whose corresponding callee parameter is a nullable
	 * struct value type (`T?` where T is a non-class struct). Populated during
	 * the check pass when the callee's signature is resolved. The build uses
	 * this to emit (and forward) the companion `_has` flag alongside the
	 * struct pointer — see ROADBLOCKS "Nullable structs".
	 */
	nullable_param_indices?: number[];
	/**
	 * Indices of arguments whose corresponding callee parameter is a `view T`
	 * (notably `view string`). Populated during the check pass when the
	 * callee's signature is resolved. The build uses this to pass the (ptr,
	 * len) pair at the call boundary: a view-typed argument passes through,
	 * an owned `string` argument is wrapped with its strlen.
	 */
	view_param_indices?: number[];
	swap_params?: Map<number, BaseNode>;
	variadic_param_name?: string;
	variadic_param_index?: number;
	/**
	 * Named-field struct literal overrides that target defaulted fields
	 * (fields not exposed as `#init` params). Each entry is applied as a
	 * post-construction field assignment after the call returns. Populated
	 * by `convert_anon_struct` and consumed by the build backends.
	 */
	field_overrides?: { name: string; value: BaseNode; type?: Type }[];
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
	 * the build's inline `to_string` paths fire. Stored as a string (the int
	 * literal text), not a ValueNode, to keep this node type-agnostic.
	 */
	inferred_array_length?: string;
	/**
	 * Set when this call was rewritten from a shorthand enum-with-args
	 * constructor `.case(args)` (the parser yields a FunctionCallNode whose
	 * name is `.case`; the checker rewrites it to `Enum_case` and sets this
	 * flag). The build lowers it as an enum case constructor (allocating a
	 * tag+payload temp), mirroring `Enum.case(args)` access calls.
	 */
	is_enum_shorthand?: boolean;

	constructor(start: number, name: string, type?: Type, params?: BaseNode[], is_static?: boolean) {
		super("func_call", start);
		this.name = name;
		this.type = type || new Type("");
		this.params = params || [];

		// HACK: For testing
		this.is_static = !!is_static;
	}
}
