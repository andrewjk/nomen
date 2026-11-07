import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class ParameterNode extends BaseNode {
	declaration: "const" | "var" = "const";
	name: string;
	type: Type;
	default_value?: BaseNode;
	constraint?: BaseNode;
	type_start?: number;
	name_start?: number;
	default_value_start?: number;
	is_self_param?: boolean;
	// `is_moved` is inherited from BaseNode (a mv parameter / mv expression).
	is_ref?: boolean;
	is_variadic?: boolean;
	/**
	 * Declared field set (FIELD_EFFECTS.md): the fields of this `ref`
	 * parameter the function may displace or free, written as a bare brace
	 * set after the name — `ref Item item { name, cache }`. Present ONLY when
	 * the author wrote a set — undefined means wildcard (the parameter may
	 * displace anything; callers' borrows rooted at the argument are all
	 * invalidated, today's whole-owner behavior). An empty array is `{}`: the
	 * body touches only value-type storage, so calls invalidate nothing.
	 */
	field_set?: string[];
	/**
	 * Source span of the declared set — the first field name through its end
	 * (or the empty region between empty braces) — so editor quick fixes can
	 * extend the set in place.
	 */
	field_set_span?: { start: number; end: number };
	/**
	 * Set when this is a variadic tuple parameter (`...[T1, T2, ...]`).
	 * At the call site, consecutive arguments are grouped into tuples.
	 */
	is_variadic_tuple?: boolean;
	func_params?: ParameterNode[];
	func_return_type?: Type;
	/**
	 * Parallel-length equalities (`a.length == b.length` conjuncts) stripped
	 * from `constraint` at signature-registration time — before any call site
	 * can observe this function, so declaration order never matters (a
	 * forward-referenced callee must not ask its caller to prove a clause no
	 * call site could). The callee's own param check seeds
	 * `status.equal_lengths` from these so its body still gets the assumption.
	 */
	stripped_length_equalities?: { a: string; b: string; field: string }[];
	constructor(
		start: number,
		name: string,
		type?: Type,
		default_value?: BaseNode,
		is_self_param?: boolean,
		declaration?: "const" | "var" | "mv",
	) {
		super("param", start);
		this.name = name;
		this.type = type || new Type("");
		this.default_value = default_value;
		this.is_self_param = is_self_param;
		if (declaration) {
			this.declaration = declaration === "const" ? "const" : "var";
			if (declaration === "mv") {
				this.is_moved = true;
			}
		}
	}
}
