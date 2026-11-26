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
	/**
	 * An owning struct's auto-init parameter for a dynamic `Array<T>` field:
	 * the struct takes the caller's buffer, so the argument must be a fresh
	 * array or an explicit `mv` transfer (a plain variable would alias).
	 */
	takes_array_buffer?: boolean;
	/**
	 * COMPTIME.md stage 4 (R4): a comptime type parameter — `type T` (or
	 * the plan's `T: type` spelling). The parameter NAMES a type instead of
	 * holding a runtime value: the call site passes the type as a bare name,
	 * the body references it wherever a type (or `META.info(T)` argument)
	 * goes, and the specialization erases it from the signature — it has no
	 * runtime representation and is never sized, laid out, or emitted.
	 */
	is_comptime_type?: boolean;
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
	 * The set was DERIVED, not written: a concrete value-struct receiver
	 * whose every field is value storage provably displaces nothing, so the
	 * checker supplies `{}` (see utils/field_effects.ts). Signatures and
	 * hovers show the author's text, so the extension skips derived sets.
	 */
	field_set_derived?: boolean;
	/**
	 * Set when this is a variadic tuple parameter (`...[T1, T2, ...]`).
	 * At the call site, consecutive arguments are grouped into tuples.
	 */
	is_variadic_tuple?: boolean;
	/**
	 * Case-payload splices (enum-body `#for` arms): a generated case's
	 * payload param may spell its TYPE and/or NAME as `#{...}` templates
	 * over the loop binding — `case #{c.name}(#{c.params[0].type.name}
	 * #{c.params[0].name})`, or the whole param at once
	 * (`case #{c.name}(#{c.params[0]})` — the type slot splice with no
	 * name slot). The enum's expansion resolves both through the binding's
	 * source-case params. `name` stays "" until then.
	 */
	comptime_name?: string;
	comptime_type_template?: string;
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
