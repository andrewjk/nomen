import type CheckStatus from "../CheckStatus.ts";

/**
 * Whether `type_name` is a `Box<T>` instantiation (STRUCT_PLAN_3 B2): the
 * compiler-generated wrapper class (`Box_<T>` monos) whose single field
 * `__value` holds the pointee. Access through a box is transparent — the
 * checker rewrites `box.f` to `box.__value.f` — so user code never names
 * the wrapper field.
 *
 * Shape-checked (a wrapper is a CLASS with exactly one `__value` field), so
 * a USER struct named `Box` (SPEC's own sizing example) is not mistaken for
 * one.
 */
export function is_box_type(type_name: string | undefined, status: CheckStatus): boolean {
	if (!type_name) return false;
	if (type_name !== "Box" && !type_name.startsWith("Box_")) return false;
	const declared =
		type_name === "Box"
			? status.structs.find((st) => st.name === "Box")
			: status.structs.find((st) => st.name === type_name && st.is_class);
	if (!declared || !declared.is_class) return false;
	if (type_name === "Box" && !declared.is_generic) return false;
	return declared.fields.length === 1 && declared.fields[0].name === "__value";
}
