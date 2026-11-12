import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import NullAccessNode from "../nodes/NullAccessNode.ts";
import type Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";

/** Resolve a field's declared type for the synthesized access steps (the
 *  checkers/builders pass their status-backed struct lookup). */
export type FieldResolver = (type_name: string, field_name: string) => Type | undefined;

/**
 * Flatten a nullable chain (`a?.b`, `a?.b?.c`, `a?.b.c`, `a?.m(args)`,
 * `f()?.x` — after the checker hoisted the call base) into the pieces the
 * checkers and builders need:
 *
 * - `hops` — one entry per conditional step, each a plain access-path
 *   expression (`a`, then `a.b`). A hop whose type is NULLABLE carries a
 *   null condition (the in-band ptr half for strings, the `_has` companion
 *   for scalars and inline structs); a non-nullable hop adds none — its
 *   chain result is null exactly when an earlier hop is.
 * - `value` — the guarded VALUE path, an ordinary (non-null) access chain
 *   (`a.b.c`) or the checked method call (`a.m(args)`) built only when
 *   every hop is non-null. Plain access nodes — already understood by both
 *   backends — so the chain needs no bespoke field emission. With a
 *   `resolve_field` callback the synthesized steps carry their field types
 *   (hops derive their null tests from them).
 *
 * Returns undefined when the chain has no `?.` step (nothing to flatten).
 */
export default function flatten_null_chain(
	expr: BaseNode,
	resolve_field?: FieldResolver,
):
	| {
			hops: BaseNode[];
			value: BaseNode;
	  }
	| undefined {
	// Type of an expression already in the chain: a null-access node's own
	// type, an access step's field type, or a value's stamped type.
	const type_of = (n: BaseNode): Type | undefined => {
		if (n.node_type === "null_access") return (n as NullAccessNode).type;
		if (n.node_type === "access") {
			const an = n as AccessNode;
			if (an.access.node_type === "access_field") return (an.access as AccessFieldNode).type;
			return undefined;
		}
		return (n as { type?: Type }).type;
	};
	// A fresh access step, typed from the field declaration when a resolver
	// is available (the synthesized steps have no stamps of their own).
	const step = (start: number, target: BaseNode, field: string): AccessNode => {
		const target_type = type_of(target);
		const step_type =
			target_type?.name && resolve_field ? resolve_field(target_type.name, field) : undefined;
		return new AccessNode(start, target, new AccessFieldNode(start, field, step_type));
	};
	const walk = (node: BaseNode): { hops: BaseNode[]; value: BaseNode } | undefined => {
		if (node.node_type === "grouped") {
			// A grouped chain `(a?.b)`: flatten its inner chain — the hop
			// tests and the value path are unchanged.
			return walk((node as unknown as { value: BaseNode }).value);
		}
		if (node.node_type === "null_access") {
			const na = node as NullAccessNode;
			const inner = walk(na.target);
			if (!inner) {
				// The base of the chain: a value or a field path.
				const hop = na.target;
				return {
					hops: [hop],
					value: chain_value_step(na, hop),
				};
			}
			// A chained hop: the test applies to the member path the inner
			// chain produced, and the value continues from the same path.
			return {
				hops: [...inner.hops, inner.value],
				value: chain_value_step(na, inner.value),
			};
		}
		if (node.node_type === "access") {
			const an = node as AccessNode;
			const inner = walk(an.target);
			if (!inner) return undefined;
			// A plain access after a conditional hop continues the value path.
			if (an.access.node_type !== "access_field") return undefined;
			const af = an.access as AccessFieldNode;
			return {
				hops: inner.hops,
				value: step(an.start, inner.value, af.name),
			};
		}
		// A bare base (no chain anywhere) — only reached through the recursive
		// walk before a `?.` step exists.
		return undefined;
	};
	// The chain's value path for one `?.` step: a synthesized field read, or
	// the CHECKED method call (`a?.m(args)` — the checker keeps the checked
	// `AccessNode` on the node so its stamps ride along).
	const chain_value_step = (na: NullAccessNode, base_path: BaseNode): BaseNode => {
		if (na.access.node_type === "access_func") {
			return na.call ?? new AccessNode(na.start, base_path, na.access);
		}
		return step(na.start, base_path, na.access.name);
	};
	const result = walk(expr);
	if (!result?.hops.length) return undefined;
	// A chain whose FINAL member is itself a flagged nullable (`a?.b.c`, c
	// a nullable scalar/struct): the field's own `_has` flag becomes one
	// more hop — the chain result is null exactly when an earlier hop OR
	// the member itself is. (Strings carry null IN BAND, so a nullable
	// string member rides the value pair and needs no test.)
	const final_t = type_of(result.value);
	if (
		final_t?.is_nullable &&
		final_t.name !== "string" &&
		result.hops[result.hops.length - 1] !== result.value
	) {
		result.hops.push(result.value);
	}
	return result;
}

/** True when the expression contains a nullable-chaining step. */
export function has_null_chain(expr: BaseNode): boolean {
	if (!expr) return false;
	if (expr.node_type === "null_access") return true;
	if (expr.node_type === "access") {
		const an = expr as AccessNode;
		return an.target ? has_null_chain(an.target) : false;
	}
	if (expr.node_type === "grouped") {
		return has_null_chain((expr as unknown as { value: BaseNode }).value);
	}
	return false;
}

/** Whether a hop's nullable representation is the in-band string null
 *  (`ptr == 0`) rather than a companion `_has` flag. */
export function nullable_hop_is_string(t: Type | undefined): boolean {
	return !!t && t.is_nullable === true && t.name === "string";
}

/** The base binding name of a chain (`a` in `a.b?.c`), for the target-style
 *  checks (the base must be a name / field path, never a call). */
export function null_chain_base(expr: BaseNode): ValueNode | undefined {
	if (expr.node_type === "value") return expr as ValueNode;
	if (expr.node_type === "access") {
		return null_chain_base((expr as AccessNode).target);
	}
	if (expr.node_type === "null_access") {
		return null_chain_base((expr as NullAccessNode).target);
	}
	return undefined;
}
