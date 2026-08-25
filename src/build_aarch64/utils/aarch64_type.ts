import { get_built_in_type } from "../../built_in_types.ts";

/**
 * Assembler data directive for a static value of `type`, derived from the
 * built-in type table: floats emit as doubles, ints by storage width
 * (BuiltInTypeInfo.bytes). Unknown names (structs/enums/generics) are words.
 */
export default function aarch64_type(type: string): string {
	const info = get_built_in_type(type);
	if (!info) return ".quad";
	if (info.kind === "float") return ".double";
	switch (info.bytes) {
		case 1:
			return ".byte";
		case 2:
			return ".short";
		case 4:
			return ".long";
		default:
			return ".quad";
	}
}
