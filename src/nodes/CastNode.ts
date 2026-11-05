import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class CastNode extends BaseNode {
	value: BaseNode;
	target_type: Type;
	type: Type;
	operator_func?: { struct_name: string; func_name: string; mangled_name?: string };
	/**
	 * BASE↔CASE enum conversion (PERF_PLAN item 13(3), the checked case
	 * cast): `r as Res.ok` narrows with a runtime tag check (panic on
	 * variant mismatch — the explicit, `_or_panic`-style surface; there is
	 * no implicit base→case conversion), `case_val as Res` widens soundly.
	 * Both directions COPY: the result is an independent value, the source
	 * keeps ownership — no moved stamping. Stamped by check_cast_node; the
	 * backends emit the check + the copy.
	 */
	enum_case_conversion?: { direction: "case_to_base" | "base_to_case" };

	constructor(start: number, value: BaseNode, target_type: Type) {
		super("cast", start);
		this.value = value;
		this.target_type = target_type;
		this.type = target_type;
	}
}
