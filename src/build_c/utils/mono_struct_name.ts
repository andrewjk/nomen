import Type from "../../nodes/Type.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Resolve a generic-struct type applied to concrete type args (e.g.
 * `List<int>`) to its monomorphized struct name (`List_int`), returning the
 * plain type name when there are no type args or no non-generic mono struct
 * is registered for them. The check phase materializes the mono struct for
 * every explicitly-instantiated generic type (instantiate_generic_type), so
 * the mono form always exists once checking succeeded — the bare generic
 * name must never reach a C signature or field access because generic
 * structs have no emitted body (an incomplete type in C).
 */
export default function mono_struct_name(type: Type, status: BuildStatus): string {
	if (!type.type_args?.length) return type.name;
	const mono_name = `${type.name}_${type.type_args.map((t) => t.name).join("_")}`;
	return status.structs.find((s) => s.name === mono_name && !s.is_generic) ? mono_name : type.name;
}
