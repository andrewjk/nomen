import { is_built_in_type } from "../../built_in_types.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import StructNode from "../../nodes/StructNode.ts";

/**
 * Whether a type's origin is entirely within the System library: a primitive,
 * or a System struct whose own concrete type arguments are all System-origin
 * (so `Buffer<int>` / `List<int>` are System, but `List<UserType>` is not).
 * Memoized per build via a cache stashed on the structs array.
 */
function type_origin_is_system(
	name: string,
	structs: StructNode[],
	cache: Map<string, boolean>,
): boolean {
	const cached = cache.get(name);
	if (cached !== undefined) return cached;
	cache.set(name, false); // cycle guard
	let result = false;
	if (is_built_in_type(name)) {
		result = true;
	} else {
		const s = structs.find((x) => x.name === name);
		if (s && s.is_library) {
			if (!s.source_type_args || s.source_type_args.length === 0) {
				result = true;
			} else {
				result = s.source_type_args.every((arg) => type_origin_is_system(arg.name, structs, cache));
			}
		}
	}
	cache.set(name, result);
	return result;
}

function system_origin_cache(structs: StructNode[]): Map<string, boolean> {
	const c = (structs as any).__system_origin_cache as Map<string, boolean> | undefined;
	if (c) return c;
	const fresh = new Map<string, boolean>();
	(structs as any).__system_origin_cache = fresh;
	return fresh;
}

/**
 * Whether a top-level definition belongs in the precompilable System
 * translation unit (`system.o`).
 *
 *  - Non-generic System code (Console, int_to_string, traits, runtime) → system.
 *  - Generics monomorphized with ONLY System type args (`Buffer<int>`,
 *    `List<int>`) → system. These are identical across every program that uses
 *    them, so the canonical prebuild instantiates them and they live in the one
 *    cached object. (Required in particular because non-generic System code
 *    like BigInt embeds `Buffer<int>` by value.)
 *  - Generics with any user type arg (`List<Animal>`) → user TU.
 *  - Tuples (`_Tuple_…`) → user TU: auto-generated per use, and the only
 *    non-generic System user of tuples is GUI code (Controls), which is
 *    excluded from system.o anyway.
 *  - All user code → user TU.
 *
 * Struct methods ride along with their owning struct's classification.
 */
export default function is_system_definition(
	node: BaseNode,
	structs: StructNode[],
	system_set?: Set<string>,
): boolean {
	if (node.node_type === "func") {
		return !!(node as FunctionNode).is_library;
	}
	if (node.node_type === "struct") {
		const s = node as StructNode;
		// When the set of structs in the precompiled system.o is known (user-TU
		// builds), a struct is System iff it's in that set. This is exact: any
		// generic/tuple the canonical didn't instantiate (e.g. `Buffer<float>`,
		// `_Tuple_int_string_bool`) falls through to the user TU.
		if (system_set) return system_set.has(s.name);
		// Otherwise (the canonical system-TU build itself, where the set is
		// being produced) use the origin rule.
		if (!s.is_library) {
			if (s.name.startsWith("_Tuple_") && s.fields.length > 0) {
				const cache = system_origin_cache(structs);
				return s.fields.every((f) =>
					type_origin_is_system((f.type as { name: string }).name, structs, cache),
				);
			}
			return false;
		}
		if (!s.source_type_args || s.source_type_args.length === 0) return true;
		const cache = system_origin_cache(structs);
		return s.source_type_args.every((arg) => type_origin_is_system(arg.name, structs, cache));
	}
	if (node.node_type === "enum") {
		const e = node as unknown as {
			is_library?: boolean;
			is_generic?: boolean;
			name: string;
		};
		if (e.is_library) return true;
		if (system_set) return system_set.has(e.name);
		// Canonical system-TU build: the only non-library CONCRETE enums in
		// this parse are monomorphizations created for System signatures
		// (`out Result<bool, FileError>` on File.open) — the prebuilt object
		// must provide them, since System method bodies construct them.
		return !e.is_generic;
	}
	if (node.node_type === "trait" || node.node_type === "bitset") {
		return !!(node as { is_library?: boolean }).is_library;
	}
	if (node.node_type === "declare") {
		return !!(node as { is_library?: boolean }).is_library;
	}
	return false;
}

/**
 * Whether a node should be emitted under the current build's `emit_mode`:
 * "system" → only system definitions; "user" → everything else; "all" → all.
 */
export function should_emit_definition(
	node: BaseNode,
	emit_mode: "all" | "system" | "user" | undefined,
	structs: StructNode[],
	system_set?: Set<string>,
): boolean {
	if (emit_mode === "system") return is_system_definition(node, structs, system_set);
	if (emit_mode === "user") return !is_system_definition(node, structs, system_set);
	return true;
}
