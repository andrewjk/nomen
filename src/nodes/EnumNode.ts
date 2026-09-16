import BaseNode from "./BaseNode.ts";
import ParameterNode from "./ParameterNode.ts";
import Type from "./Type.ts";

export default class EnumNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	cases: { name: string; params: ParameterNode[] }[];
	/** True when this enum is defined in the appended System library source. */
	is_library?: boolean;
	/** Type parameter names (e.g. ["T", "E"] in `enum Result<T, E>`). */
	type_params: string[];
	/** True when type_params is non-empty (set during check). */
	is_generic?: boolean;
	/**
	 * True when declared with the `must_use` modifier (`pub must_use enum Result<T, E>`).
	 * A must_use enum's values may not be silently discarded: a statement-position
	 * call whose result type is a must_use enum is a compile error. Callers must
	 * bind the value (e.g. `var _ = f.close()`) or match on it. Copied onto
	 * monomorphized instantiations by `monomorphize_enum`.
	 */
	must_use?: boolean;
	/** Set on monomorphized instantiations: the generic template's name. */
	template_name?: string;
	/** Set on monomorphized instantiations: the concrete type args. */
	template_args?: Type[];
	/**
	 * The source-level name when `name` was rewritten to a scope-unique
	 * emission label (see `assign_type_label` in check_block_node). Undefined
	 * for top-level enums, whose source name IS their emission name.
	 */
	source_name?: string;

	constructor(
		start: number,
		visibility: "pub" | "private",
		name: string,
		cases?: { name: string; params: ParameterNode[] }[],
	) {
		super("enum", start);
		this.visibility = visibility;
		this.name = name;
		this.cases = cases || [];
		this.type_params = [];
	}

	get has_associated_data(): boolean {
		return this.cases.some((c) => c.params.length > 0);
	}
}
