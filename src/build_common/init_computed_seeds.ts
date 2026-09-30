import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";

/**
 * The `self.<field> = <expr>` string-field writes of a struct's custom `#init`
 * bodies (every overload), keyed by field name. `top_level` writes are DIRECT
 * statements of the init body — they execute on every path; `nested` writes
 * sit inside if/loop/switch blocks. Nested func/struct/trait declarations are
 * boundaries and are not descended into (separate functions).
 */
interface InitStringWrites {
	top_level: Map<string, BaseNode[]>;
	nested: Map<string, BaseNode[]>;
}

function is_plain_string_field(field: {
	type: { name?: string; is_ref?: boolean; is_array?: boolean; is_view?: boolean };
}): boolean {
	return (
		field.type.name === "string" &&
		!field.type.is_ref &&
		!field.type.is_array &&
		!field.type.is_view
	);
}

/** The `(field, rhs)` of a `self.<field> = <rhs>` write, or undefined. */
function self_string_field_write(
	node: BaseNode,
	string_fields: Set<string>,
): { field: string; rhs: BaseNode } | undefined {
	if (node.node_type !== "assign") return undefined;
	const lhs = (node as unknown as { left_value?: BaseNode }).left_value;
	if (lhs?.node_type !== "access") return undefined;
	const access = lhs as AccessNode;
	if (access.access.node_type !== "access_field") return undefined;
	const target = access.target as { node_type?: string; value?: string };
	if (target?.node_type !== "value" || target.value !== "self") return undefined;
	const field = (access.access as AccessFieldNode).name ?? "";
	if (!string_fields.has(field)) return undefined;
	return { field, rhs: (node as unknown as { right_value: BaseNode }).right_value };
}

/** Visit every AST node reachable from `value` — through arrays AND
 *  single-node properties — skipping `parent`/`scope` back-references and NOT
 *  descending INTO nested `func`/`struct`/`trait` declarations. */
function walk(value: unknown, cb: (n: BaseNode) => void) {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) walk(item, cb);
		return;
	}
	const n = value as BaseNode;
	const is_boundary = n.node_type === "func" || n.node_type === "struct" || n.node_type === "trait";
	if (typeof n.node_type === "string") cb(n);
	if (is_boundary) return;
	for (const key of Object.keys(value as Record<string, unknown>)) {
		if (key === "parent" || key === "scope" || key === "node_type") continue;
		walk((value as Record<string, unknown>)[key], cb);
	}
}

function collect_init_string_writes(struct_node: StructNode, init: FunctionNode): InitStringWrites {
	const string_fields = new Set(
		struct_node.fields.filter(is_plain_string_field).map((f) => f.name),
	);
	const top_level = new Map<string, BaseNode[]>();
	const nested = new Map<string, BaseNode[]>();
	const add = (m: Map<string, BaseNode[]>, field: string, rhs: BaseNode) => {
		const list = m.get(field);
		if (list) list.push(rhs);
		else m.set(field, [rhs]);
	};
	for (const stmt of init.statements ?? []) {
		const write = self_string_field_write(stmt, string_fields);
		if (write) {
			add(top_level, write.field, write.rhs);
			continue;
		}
		walk(stmt, (n) => {
			const nested_write = self_string_field_write(n, string_fields);
			if (nested_write) add(nested, nested_write.field, nested_write.rhs);
		});
	}
	return { top_level, nested };
}

/**
 * The plain string fields of `struct_node` that its custom `#init` COMPUTES as
 * a definitely-heap-owning value: for EVERY `#init` overload, the field is
 * either written at least once as a DIRECT body statement with every write
 * (direct or nested) passing `is_owned_heap` — or never written and its
 * DEFAULT also passes `is_owned_heap` (the overload leaves the default in
 * place). A param-alias seed (`self.a = s`) never qualifies: the seed borrows
 * the caller's argument temp, so it must never be recorded or freed.
 *
 * Binding sites record qualifying fields (scope exit frees the computed seed;
 * a displaced store reclaims it); override sites treat them as displaced (the
 * raw override store orphans the computed buffer). A param-alias seed or a
 * conditional computed write over a rodata default leaves a path holding a
 * non-heap value — such fields stay unqualified (bounded leak on the write
 * path, never an invalid free).
 */
export function init_computed_heap_string_fields(
	struct_node: StructNode,
	is_owned_heap: (expr: BaseNode) => boolean,
): Set<string> {
	const result = new Set<string>();
	const inits = struct_node.functions.filter((f) => f.name === "#init" && f.has_body);
	if (!inits.length) return result;
	for (const field of struct_node.fields) {
		if (!is_plain_string_field(field)) continue;
		const default_is_heap = !!field.value && is_owned_heap(field.value);
		let written_somewhere = false;
		let qualifies = true;
		for (const init of inits) {
			const writes = collect_init_string_writes(struct_node, init);
			const direct = writes.top_level.get(field.name) ?? [];
			const all = [...direct, ...(writes.nested.get(field.name) ?? [])];
			if (all.length === 0) {
				// This overload never writes the field: the default stays — it
				// must own heap on its own for the field to be definitely heap.
				if (!default_is_heap) {
					qualifies = false;
					break;
				}
				continue;
			}
			written_somewhere = true;
			if (!all.every((expr) => is_owned_heap(expr))) {
				qualifies = false;
				break;
			}
			// Every path leaves heap: a DIRECT write dominates (every path
			// stores a computed heap value), or an unconditional-heap default
			// covers the no-write paths of nested-only writes.
			if (direct.length === 0 && !default_is_heap) {
				qualifies = false;
				break;
			}
		}
		if (qualifies && written_somewhere) result.add(field.name);
	}
	return result;
}

/**
 * The write-site half: does THIS custom-`#init` write to `self.<field>`
 * displace a heap-owning DEFAULT seed that must be reclaimed ahead of the
 * store? True only for the field's first write in the body (the displaced
 * value is then statically the default — later writes displace values whose
 * ownership the init cannot know, and keep the status quo). Marks the field
 * reclaimed on true so a second write never frees what the first stored.
 *
 * Sound even for conditional first writes: the free rides in the same branch
 * as the store, and the displaced value is still the default at that point.
 */
export function claim_init_default_seed_reclaim(
	status: {
		current_struct?: StructNode;
		current_function?: FunctionNode;
		init_default_reclaimed_fields?: Set<string>;
	},
	field_name: string,
	is_owned_heap: (expr: BaseNode) => boolean,
): boolean {
	if (status.current_function?.name !== "#init" || !status.current_struct) return false;
	if (status.init_default_reclaimed_fields?.has(field_name)) return false;
	const field = status.current_struct.fields.find((f) => f.name === field_name);
	if (!field || !field.value || !is_plain_string_field(field)) return false;
	if (!is_owned_heap(field.value)) return false;
	if (!status.init_default_reclaimed_fields) status.init_default_reclaimed_fields = new Set();
	status.init_default_reclaimed_fields.add(field_name);
	return true;
}
