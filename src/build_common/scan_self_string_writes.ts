import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";

/**
 * The plain (owned, non-ref, non-array) `string` fields of a VALUE struct that
 * a method may overwrite through `self` — direct `self.<field> = ...` writes
 * plus writes made by same-struct methods the method calls on `self`
 * (transitively). Nested function/struct declarations inside the body are
 * boundaries and are not descended into (they are separate functions).
 */
export function scan_self_string_field_writes(
	struct: StructNode,
	method: FunctionNode,
): Set<string> {
	const string_fields = new Set(
		struct.fields
			.filter((f) => f.type.name === "string" && !f.type.is_ref && !f.type.is_array)
			.map((f) => f.name),
	);
	const written = new Set<string>();
	if (!string_fields.size) return written;
	const visited = new Set<string>();
	const scan_method = (func: FunctionNode) => {
		if (visited.has(func.name)) return;
		visited.add(func.name);
		walk(func.statements ?? [], (n) => {
			if (n.node_type === "assign") {
				const lhs = (n as unknown as { left_value?: BaseNode }).left_value;
				if (lhs?.node_type !== "access") return;
				const access = lhs as AccessNode;
				if (access.access.node_type !== "access_field") return;
				const target = access.target as { node_type?: string; value?: string };
				const field = (access.access as AccessFieldNode).name ?? "";
				if (target?.node_type === "value" && target.value === "self") {
					if (string_fields.has(field)) written.add(field);
				}
			} else if (n.node_type === "access") {
				const access = n as AccessNode;
				if (access.access.node_type !== "access_func") return;
				const target = access.target as { node_type?: string; value?: string };
				if (target?.node_type === "value" && target.value === "self") {
					const callee = struct.functions.find(
						(f) => f.name === (access.access as AccessFunctionCallNode).name,
					);
					if (callee) scan_method(callee);
				}
			}
		});
	};
	scan_method(method);
	return written;
}

/**
 * Drop a receiver's heap_string_fields records for the fields a value-struct
 * method may have overwritten through `self`. The method's writes go through
 * to the caller's storage, and the method cannot know whether the displaced
 * values were heap-owned — that knowledge lives in the CALLER's records. A
 * surviving record could free a non-heap value at scope exit (invalid free),
 * so the records are dropped WITHOUT emitting frees. Conservative: a heap
 * value the method displaced or wrote leaks instead of being freed — never a
 * double-free.
 */
export function drop_self_written_string_field_records(
	status: { heap_string_fields?: Set<string> },
	receiver_name: string,
	fields: Set<string>,
) {
	if (!status.heap_string_fields?.size || !fields.size) return;
	for (const field of fields) {
		status.heap_string_fields.delete(`${receiver_name}.${field}`);
	}
}

/** Visit every AST node reachable from `value` — through arrays AND
 *  single-node properties (an `if` node's branch blocks are node objects, not
 *  statement arrays) — skipping `parent`/`scope` back-references and NOT
 *  descending INTO nested `func`/`struct`/`trait` declarations (a nested
 *  function's body is a separate function, not part of this one's writes). */
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
