import Type from "../../nodes/Type.ts";

export default function type_name(type: Type): string {
	const args = type.type_args?.length
		? `<${type.type_args.map((t: Type) => type_name(t)).join(", ")}>`
		: "";
	return `${type.name}${args}${type.is_nullable ? "?" : ""}${type.is_array ? `[]` : ""}`;
}
