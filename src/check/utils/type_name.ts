import Type from "../../nodes/Type.ts";

export default function type_name(type: Type): string {
	if (type.tuple_types?.length && type.name === "tuple") {
		return `[${type.tuple_types.map((t) => type_name(t)).join(", ")}]${type.is_nullable ? "?" : ""}`;
	}
	if (type.is_array) {
		const elem = type_name_without_array(type);
		return `Array<${elem}>${type.is_nullable ? "?" : ""}`;
	}
	const args = type.type_args?.length
		? `<${type.type_args.map((t: Type) => type_name(t)).join(", ")}>`
		: "";
	const prefix = type.is_ref ? "ref " : "";
	return `${prefix}${type.name}${args}${type.is_nullable ? "?" : ""}`;
}

function type_name_without_array(type: Type): string {
	const args = type.type_args?.length
		? `<${type.type_args.map((t: Type) => type_name(t)).join(", ")}>`
		: "";
	const prefix = type.is_ref ? "ref " : "";
	return `${prefix}${type.name}${args}`;
}
