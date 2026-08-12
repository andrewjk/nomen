import type BaseNode from "../../nodes/BaseNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";

export function is_class_type(type_name: string, status: CheckStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && s.is_class);
}

/**
 * True if a value of `type_name` is stored in a container as an OWNED
 * 8-byte heap pointer that the container's `#destroy` will reclaim
 * per-element. That covers both classes (ClassBuffer<T> routing) and
 * traits (ClassBuffer<Trait> routing, dispatching destroy via the
 * vtable). Storing a BORROW of such a type into a `mov T` slot would
 * create shared ownership: the destination's destroy frees the pointer
 * while the source still references it (a runtime double-free, SIGABRT).
 */
export function is_owning_ref_type(type_name: string, status: CheckStatus): boolean {
	if (is_class_type(type_name, status)) return true;
	return !!status.traits.find((t) => t.name === type_name);
}

/**
 * Resolve a Type to its StructNode definition. Tries the exact (monomorphized)
 * name first, then a synthesized monomorphization name from type args
 * (e.g. List + [Animal] -> List_Animal).
 */
function resolve_struct(type: Type, status: CheckStatus): StructNode | undefined {
	if (!type.name) return undefined;
	const direct = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
	if (direct) return direct;
	if (type.type_args?.length) {
		const mono = type.name + "_" + type.type_args.map((t) => t.name).join("_");
		return status.structs.find((s) => s.name === mono && !s.is_simple_type);
	}
	return undefined;
}

/**
 * Recursively determine whether an AST subtree contains a `raw` node (an inline
 * asm/C block). Used to tell apart a `#destroy` that actually releases a
 * resource (free/fclose/release are always emitted via raw blocks in Nomen) from
 * a benign cleanup hook that only resets fields (e.g. `self.id = 0`). The walk
 * skips `scope`/`parent` back-edges and is cycle-guarded.
 */
function contains_raw(node: BaseNode, visited: WeakSet<BaseNode>): boolean {
	if (!node || typeof node !== "object" || visited.has(node)) return false;
	visited.add(node);
	if (node.node_type === "raw") return true;
	for (const key of Object.keys(node)) {
		if (key === "scope" || key === "parent") continue;
		const val = (node as unknown as Record<string, unknown>)[key];
		if (val && typeof val === "object" && "node_type" in val) {
			if (contains_raw(val as BaseNode, visited)) return true;
		} else if (Array.isArray(val)) {
			for (const item of val) {
				if (item && typeof item === "object" && "node_type" in item) {
					if (contains_raw(item as BaseNode, visited)) return true;
				}
			}
		}
	}
	return false;
}

function destroy_releases(func: FunctionNode): boolean {
	const visited = new WeakSet<BaseNode>();
	return func.statements.some((s) => contains_raw(s, visited));
}

/**
 * True if `type` is a struct (not a class, not a primitive) that transitively
 * owns a resource that would be double-freed by a byte copy. That is:
 *   - its `#destroy` actually releases something (contains a raw block), or
 *   - it has a field that is a class, or another owning struct.
 *
 * A benign `#destroy` that only resets fields (no raw block) does NOT make a
 * struct owning — copying such a value type is safe. Classes are reference
 * types (assigning aliases the pointer, one owner), so they are not owning.
 */
export function is_owning_struct_type(type: Type, status: CheckStatus): boolean {
	const s = resolve_struct(type, status);
	if (!s || s.is_class) return false;
	return struct_owns_heap(s, status, new Set());
}

function struct_owns_heap(s: StructNode, status: CheckStatus, visited: Set<string>): boolean {
	if (visited.has(s.name)) return false;
	visited.add(s.name);
	const destroy = s.functions.find((f) => f.name === "#destroy");
	if (destroy && destroy_releases(destroy)) return true;
	for (const field of s.fields) {
		if (field.type.is_ref) continue;
		// A `string` field owns heap memory (a strdup'd char*). The field
		// may hold a static literal pointer at runtime, but the owning copy
		// (constructor strdup, deep-copy on container store) is always heap.
		if (field.type.name === "string") return true;
		const field_struct = resolve_struct(field.type, status);
		if (!field_struct) continue;
		if (field_struct.is_class) return true;
		if (struct_owns_heap(field_struct, status, visited)) return true;
	}
	return false;
}
