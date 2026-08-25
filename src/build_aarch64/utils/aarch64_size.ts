import { get_built_in_type } from "../../built_in_types.ts";

/**
 * Storage width of a value of `type` in bytes, derived from the
 * built-in type table (see BuiltInTypeInfo.bytes). Non-built-in names are
 * structs/enums/generics — 8 unless overridden by struct layout. `string`
 * is the fat 16-byte { char* ptr; long len; } pair; in registers it rides
 * as a consecutive (ptr, len) pair — the same ABI `view T` uses.
 */
export default function aarch64_size(type: string): number {
	if (type === "string") return 16;
	const info = get_built_in_type(type);
	return info?.bytes ?? 8;
}
