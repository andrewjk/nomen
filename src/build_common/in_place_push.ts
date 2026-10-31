import type AccessFieldNode from "../nodes/AccessFieldNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type Type from "../nodes/Type.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { mono_type_name } from "./mono_name.ts";

/**
 * The in-place construction guarantee (container-push tranche):
 * push. Goose compiles `items.push(parse(line))` so the parsed record is
 * written directly into the new slot — the destination is passed down, no
 * temporary, no copy. Nomen's checker hoists every non-trivial call argument
 * into a `const _param_N` (check_function_call.ts), so even the direct
 * spelling lowered as: call result into a temp home, then the callee-copies
 * `push` memcpys the temp into the slot, then the temp's buffer frees at
 * scope exit. This module carries the shared decision for the tranche-1
 * shape that deletes the temp and the copy in both backends:
 *
 *   reserve(1)                       — List.reserve: growth policy of push
 *   slot := items.data[length]       — the not-yet-pushed element slot
 *   construct <arg call> into slot   — sret (value struct) or x0/x1 store
 *   length += 1                      — the slot is now a real element
 *
 * Soundness rests on the checker stamping `in_place_push_index` ONLY when
 * every one of these holds (see check_function_call.ts):
 *
 * - the receiver is a BARE LOCAL's name (`self_value === self_path`,
 *   resolved to a non-param value of the current function — never a
 *   param, whose by-address spelling differs), or a `self.<field>...`
 *   chain of plain value-struct field hops (the field-path tranche: the
 *   address is the receiver base plus summed static offsets, and nothing
 *   the splice runs can rebind a method's `self` — callees cannot see it,
 *   and lambdas and `ref`-argument callees are rejected below);
 * - the argument expression is a direct `func_call` of exactly the element
 *   type — a function with a body (foreign callees keep the hoisted path) or
 *   a constructor of the element struct (the callee is the struct's `#init`,
 *   whose emission is unconditional; the build constructs it into the preset
 *   destination exactly like `Box<T>(T(...))` into the box slot) — with no
 *   `ref` arguments, no swap, no field overrides, and a non-view/non-nullable
 *   return;
 * - every argument OF the argument call is a bare value, an op tree, or a
 *   nested call whose own return is a simple type or string — the build may
 *   `bl` (the call emitter re-presets the spilled sret destination after
 *   each argument), but no argument can be a struct-returning call (its own
 *   suppressed `_call_ret_` preset would target the slot) or re-enter the
 *   container;
 * - the statement's value is discarded (the call is the statement) — push
 *   returns void, so this is the only context that exists;
 * - the element is `string` or a value struct — the classes whose call
 *   results own heap bytes a temp would have freed at scope exit. A class
 *   element rides as a pointer (no copy to elide); scalars aren't worth a
 *   special path.
 *
 * Evaluation order is preserved end to end: reserve runs first (extra
 * capacity is unobservable — count still bumps last), the argument call
 * runs next against the same arguments, and the slot address re-derives
 * from the receiver AFTER the argument call, so a resizing effect anywhere
 * (there is none in the gated shape, but the lowering doesn't rely on it)
 * still stores into the buffer that is current at store time.
 */

/** The value node's bare name when `node` is a `value`, else "". */
function value_name(node: BaseNode | undefined): string {
	if (!node || node.node_type !== "value") return "";
	const value = (node as { value?: unknown }).value;
	return typeof value === "string" ? value : "";
}

export interface InPlaceReceiverPath {
	/** The chain's root name (`items`, `self`). */
	root: string;
	/** The field hops, first hop from the root first (`["nodes"]`). */
	fields: string[];
	/** The chain node whose `access` is `fields[i]` (innermost first). */
	nodes: AccessNode[];
}

/**
 * The receiver as a bare name or a pure field path: `items` →
 * `{ root: "items", fields: [] }`; `self.nodes` →
 * `{ root: "self", fields: ["nodes"] }`. An index or call segment (`a[0]`,
 * `make().f`) anywhere in the chain returns undefined — the in-place
 * lowering can only address a name or summed static field offsets.
 */
export function in_place_receiver_path(
	target: BaseNode | undefined,
): InPlaceReceiverPath | undefined {
	let cursor = target;
	const nodes: AccessNode[] = [];
	while (cursor && cursor.node_type === "access") {
		const access_node = cursor as AccessNode;
		if (access_node.access?.node_type !== "access_field") return undefined;
		nodes.unshift(access_node);
		cursor = access_node.target;
	}
	const root = value_name(cursor);
	if (!root) return undefined;
	return {
		root,
		fields: nodes.map((n) => (n.access as AccessFieldNode).name),
		nodes,
	};
}

export interface InPlaceFieldPathWalk {
	/** `owners[i]` is the mono'd struct whose layout contains `fields[i]`. */
	owners: string[];
	/** The mono'd type of the final hop — the container. */
	container_mono: string;
}

/**
 * Walk a `self.<field>...` path against the struct table: every hop's
 * OWNER must be a non-generic, non-class, non-simple struct (an inline
 * value-struct layout — a class hop is a pointer hop and a generic hop an
 * unmaterialized layout, and both backends' addressing is only defined
 * for inline hops). The checker re-derives the same walk before
 * stamping, so a build-time undefined means the stamp is absent too.
 */
export function in_place_field_path_owners(
	root_struct_name: string,
	fields: readonly string[],
	structs: readonly StructNode[],
): InPlaceFieldPathWalk | undefined {
	let owner = root_struct_name;
	const owners: string[] = [];
	for (const field of fields) {
		const struct = structs.find((s) => s.name === owner);
		if (!struct || struct.is_class || struct.is_simple_type || struct.is_generic) return undefined;
		const field_decl = struct.fields.find((f) => f.name === field);
		if (!field_decl?.type?.name) return undefined;
		owners.push(owner);
		owner = mono_type_name(field_decl.type);
	}
	return { owners, container_mono: owner };
}

/** True for the simple categories whose marshalling never emits a call. */
export function in_place_element_ok(
	type: Type | undefined,
	structs: readonly StructNode[],
): type is Type & { name: string } {
	if (!type?.name) return false;
	if (type.is_view || type.is_array || type.is_ref || type.is_nullable) return false;
	if (type.name === "string") return true;
	const struct = structs.find((s) => s.name === type.name);
	return !!struct && !struct.is_simple_type && !struct.is_class && !struct.is_generic;
}

export interface InPlacePushFacts {
	/** The receiver variable's bare name (`items`), or the field path's
	 *  root (`self`). */
	receiver: string;
	/** The field hops when the receiver is `self.<field>...` (`["nodes"]`
	 *  — the address is the root's base plus the summed static field
	 *  offsets). Unset for a bare-local receiver. */
	receiver_field_path?: string[];
	/** The element type's mono name (`string`, `Point`, ...). */
	elem_name: string;
	/** True when the element is the fat string (x0/x1 return, 16-byte slot). */
	elem_is_string: boolean;
	/** The mono'd container struct name (`List_string`) — labels prefix. */
	list_mono: string;
	/** The argument call to construct into the slot. */
	arg: FunctionCallNode;
	/** True when the receiver is a heap `Array<T>` (the type is the ELEMENT
	 *  type with `is_array`/`is_array_heap` set — there is no container
	 *  struct): the backends pass the array value itself (C) / the element
	 *  base (aarch64) as the slot primitive's receiver, never `&receiver`. */
	receiver_is_array: boolean;
}

/**
 * Re-derive the mechanical facts for a stamped push call. Returns undefined
 * for a node without the stamp (the caller keeps the normal lowering — the
 * checker only skips the hoist when this will resolve). `self_struct_name`
 * is the enclosing struct's name (`status.current_struct?.name`) for the
 * field-path receiver tranche: `type_from_value_node` cannot see through an
 * access chain, so the container's mono is derived by walking the stamped
 * field types against the struct table.
 */
export function in_place_push_facts(
	access: { in_place_push_index?: number; params?: BaseNode[] },
	target: BaseNode,
	receiver_type_name: string | undefined,
	elem_type: Type | undefined,
	structs: readonly StructNode[],
	receiver_is_array = false,
	self_struct_name?: string,
): InPlacePushFacts | undefined {
	const idx = access.in_place_push_index;
	if (idx === undefined) return undefined;
	const path = in_place_receiver_path(target);
	if (!path) return undefined;
	let receiver_type = receiver_type_name;
	let field_path: string[] | undefined;
	if (path.fields.length) {
		// A `self.<field>...` receiver. Array receivers keep the bare-local
		// rule — the element-base math is name-keyed.
		if (receiver_is_array) return undefined;
		if (path.root !== "self" || !self_struct_name) return undefined;
		const walk = in_place_field_path_owners(self_struct_name, path.fields, structs);
		if (!walk) return undefined;
		receiver_type = walk.container_mono;
		field_path = path.fields;
	}
	if (!receiver_type) return undefined;
	const arg = access.params?.[idx];
	if (!arg || arg.node_type !== "func_call") return undefined;
	if (!elem_type?.name || !in_place_element_ok(elem_type, structs)) return undefined;
	return {
		receiver: path.root,
		receiver_field_path: field_path,
		elem_name: elem_type.name,
		elem_is_string: elem_type.name === "string",
		// A heap `Array<T>` parses to the ELEMENT type with the array flags —
		// the container mono is derived (`Array_<elem>`), never the type's
		// name (see build_access_node's array dispatch).
		list_mono: receiver_is_array ? `Array_${elem_type.name}` : receiver_type,
		arg: arg as FunctionCallNode,
		receiver_is_array,
	};
}

/**
 * Whether an argument expression tree is safe to build under the in-place
 * push's preset sret destination: bare values, cast/grouped wrappers, op
 * trees, and nested calls whose OWN return is a simple type or string (a
 * struct-returning nested call would take the suppressed `_call_ret_`
 * preset as its own destination — the preset window's x8). Lambdas,
 * accesses (a method call's receiver could alias the container) and arrays
 * keep the hoisted path. `bl`s anywhere in the tree are fine: the call
 * emitter re-presets x8 from the spilled slot after each argument build
 * (build_function_call_node.ts).
 */
export function in_place_arg_tree_ok(arg: BaseNode, structs: readonly StructNode[]): boolean {
	const seen = new Set<BaseNode>();
	const walk = (n: BaseNode): boolean => {
		if (!n || typeof n !== "object" || seen.has(n)) return true;
		seen.add(n);
		if (n.node_type === "func_call") {
			const tname = (n as unknown as { type?: { name?: string } }).type?.name;
			if (
				tname &&
				tname !== "string" &&
				!!structs.find((s) => s.name === tname && !s.is_simple_type && !s.is_class)
			) {
				return false;
			}
		} else if (
			n.node_type !== "value" &&
			n.node_type !== "op" &&
			n.node_type !== "cast" &&
			n.node_type !== "grouped"
		) {
			return false;
		}
		for (const key of Object.keys(n)) {
			if (key === "parent" || key === "scope") continue;
			const child = (n as unknown as Record<string, unknown>)[key];
			const children = Array.isArray(child) ? child : [child];
			for (const item of children) {
				if (item && typeof item === "object" && "node_type" in item) {
					if (!walk(item as BaseNode)) return false;
				}
			}
		}
		return true;
	};
	return walk(arg);
}

/**
 * How many times `name` appears as a bare value under `root` — every
 * expression position, including nested function bodies (a capture is a
 * use). Name-based and shadowing-conservative: a same-named inner binding
 * over-counts and disqualifies the candidate, never wrongly qualifies it
 * (forward.ts's counting discipline).
 */
export function value_use_count(name: string, root: BaseNode | undefined): number {
	if (!root) return 0;
	let count = 0;
	const seen = new Set<BaseNode>();
	const walk = (node: BaseNode): void => {
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		if (node.node_type === "value" && (node as ValueNode).value === name) count += 1;
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const child = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(child)) {
				for (const item of child) {
					if (item && typeof item === "object" && "node_type" in item) {
						walk(item as BaseNode);
					}
				}
			} else if (child && typeof child === "object" && "node_type" in child) {
				walk(child as BaseNode);
			}
		}
	};
	walk(root);
	return count;
}
