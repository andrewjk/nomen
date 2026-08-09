import Type from "../../nodes/Type.ts";

export default function type_name(type: Type): string {
	const prefix = type_modifier(type);
	// A materialized tuple (see `materialize_tuple_type`) keeps its element
	// types in `tuple_types` but renames itself to `_Tuple_T1_T2_…`. Render
	// those back as the source-level `[T1, T2]` so hovers / errors don't leak
	// the synthesized struct name.
	if (type.tuple_types?.length && (type.name === "tuple" || type.name.startsWith("_Tuple_"))) {
		return `${prefix}[${type.tuple_types.map((t) => type_name(t)).join(", ")}]${
			type.is_nullable ? "?" : ""
		}`;
	}
	if (type.is_array) {
		const elem = type_name_without_array(type);
		return `Array<${elem}>${type.is_nullable ? "?" : ""}`;
	}
	const args = type.type_args?.length
		? `<${type.type_args.map((t: Type) => type_name(t)).join(", ")}>`
		: "";
	return `${prefix}${type.name}${args}${type.is_nullable ? "?" : ""}`;
}

function type_modifier(type: Type): string {
	if (type.is_view) return "view ";
	if (type.is_ref) return "ref ";
	return "";
}

/**
 * Whether `type` is usable as an `if`/`while`/`switch` condition: a plain
 * `bool`, ignoring ref/view access modifiers (a `ref bool` reads as a bool).
 * Nullable `bool?` is rejected — branch on an explicit null comparison instead.
 */
export function is_bool_condition(type: Type): boolean {
	return type.name === "bool" && !type.is_nullable;
}

function type_name_without_array(type: Type): string {
	const args = type.type_args?.length
		? `<${type.type_args.map((t: Type) => type_name(t)).join(", ")}>`
		: "";
	return `${type_modifier(type)}${type.name}${args}`;
}
