import add_error from "../add_error.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import NullAccessNode from "../nodes/NullAccessNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_access_node from "./check_access_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { is_owned_array_call } from "./utils/hoist_array_temp.ts";
import { clone_type as full_clone_type } from "./utils/tuple_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

/**
 * ERRORS_PLAN: nullable chaining — `a?.b` (chains: `a?.b?.c`, `a?.b.c`,
 * `a?.m(args)`, `f()?.x`).
 *
 * The result is the member's type made nullable: null when the target is
 * null, the member otherwise. The chain TOLERATES a null target; plain
 * read-rejection is suspended while its base is checked.
 *
 * Single evaluation: the base and every hop must be side-effect-free reads
 * (the flatten's hop tests re-read them), so any base expression containing
 * a call — `f()?.x`, `p.find(id)?.y` — hoists into a `_chain_base_N` temp,
 * and a method-call hop with further steps (`a?.m()?.x`) hoists the
 * sub-chain into a `_chain_N` temp whose flag the outer tests read. Both
 * use the checker's allocation-hoist mechanism (the `_param_N`/`_recv_N`
 * convention); the value path itself is checked as an ordinary access and
 * kept on the node (`node.call`) so the builders emit the checked call.
 */
export default function check_null_access_node(node: NullAccessNode, status: CheckStatus): boolean {
	hoist_single_evaluation_bases(node, status);

	// The chain TOLERATES a null target (that is the operator's point) — the
	// plain read-rejection ("may be null" / known-null) is suspended for the
	// target check.
	if (node.target.node_type === "null_access") {
		(node.target as NullAccessNode).is_inner_hop = true;
	}
	const old_allow_null = status.allow_null_value;
	status.allow_null_value = true;
	const target_ok = check_node(node.target, status);
	status.allow_null_value = old_allow_null;
	if (!target_ok) return false;
	const target_type = type_from_value_node(node.target, status);
	// A nullable ARRAY (`Array<T>?` — null is the null pointer): every
	// member (`.length`, `.at_or(i, d)`) is checked as an ordinary access on
	// the non-null path, like a method-call hop.
	if (target_type.is_nullable_array) {
		const guarded = new AccessNode(node.start, node.target, node.access);
		status.allow_null_value = true;
		const ok = check_access_node(guarded, status);
		status.allow_null_value = old_allow_null;
		if (!ok) return false;
		const member_type = node.access.type;
		if (!member_type?.name) {
			add_error(status, `Field not found: ${node.access.name}`, node.access.start);
			return false;
		}
		node.call = guarded;
		if (member_type.is_array || member_type.is_view) {
			return yield_nullable_array(node, member_type, status);
		}
		node.type = clone_type(member_type);
		node.type.is_nullable = true;
		return true;
	}
	if (!target_type.is_nullable) {
		add_error(
			status,
			`'?.' needs a nullable target — '${type_name(target_type)}' is not nullable; use '.'`,
			node.start,
		);
		return false;
	}

	// A METHOD-call hop (`a?.m(args)`): the guarded call is an ordinary
	// access on the non-null path — check it through the normal access
	// machinery (types, params, resolved function), then lift its result
	// type to the chain's nullable type. The checked wrapper rides on the
	// node so the builders emit exactly what was checked.
	if (node.access.node_type === "access_func") {
		const guarded = new AccessNode(node.start, node.target, node.access);
		status.allow_null_value = true;
		const call_ok = check_access_node(guarded, status);
		status.allow_null_value = old_allow_null;
		if (!call_ok) return false;
		node.call = guarded;
		if (!node.access.type?.name) {
			add_error(status, `Field not found: ${node.access.name}`, node.access.start);
			return false;
		}
		if (node.access.type.is_array || node.access.type.is_view) {
			return yield_nullable_array(node, node.access.type, status);
		}
		node.type = clone_type(node.access.type);
		node.type.is_nullable = true;
		return true;
	}

	// Resolve the member on the base (non-null) type.
	const base_name = target_type.name;
	const struct = status.structs.findLast((s) => s.name === base_name && !s.is_generic);
	const field = struct?.fields.find((f) => f.name === node.access.name);
	if (!field?.type?.name) {
		add_error(status, `Field not found: ${node.access.name}`, node.access.start);
		return false;
	}
	if (field.type.is_array || field.type.is_view) {
		// An array member: the chain result is a nullable ARRAY (null is
		// the null pointer).
		node.access.type = full_clone_type(field.type);
		return yield_nullable_array(node, field.type, status);
	}
	node.access.type = clone_type(field.type);
	node.type = clone_type(field.type);
	node.type.is_nullable = true;

	return true;
}

/**
 * A chain whose member is an array (`xs?.copy()`, `p?.xs`, `grid?.at(0)`)
 * yields an `Array<T>?` — null is the null pointer. A further hop
 * (`p?.xs?.length`) tests it directly; otherwise the result is bound to a
 * declaration the backends know how to hold: the enclosing declaration
 * itself (`const c = xs?.copy()`), or a hoisted `_param_N` temp. A fresh
 * array (a copy, `with`, an array-returning call) is OWNED by that binding
 * (freed at scope exit, null-guarded); a member array or nested row is
 * BORROWED from its owner and never freed through the binding.
 */
function yield_nullable_array(
	node: NullAccessNode,
	member_type: Type,
	status: CheckStatus,
): boolean {
	if (member_type.is_view || member_type.storage_kind !== "heap_array") {
		add_error(
			status,
			`'?.' can only yield a heap array (Array<T>) — test the target with '!= null' first`,
			node.start,
		);
		return false;
	}
	const result_type = full_clone_type(member_type);
	result_type.is_nullable_array = true;
	node.type = result_type;
	if (node.is_inner_hop) return true;
	const owned = !!node.call && is_owned_array_call(node.call);
	const owner = status.stack.at(-1);
	if (owner?.node_type === "declare" && (owner as DeclarationNode).value === node) {
		const decl = owner as DeclarationNode;
		if (!owned) {
			if (decl.declaration !== "const") {
				add_error(
					status,
					`'${decl.name}' borrows its array from '?.' — declare it with 'const', or end the chain with '?.copy()'`,
					node.start,
				);
				return false;
			}
			decl.transferred_to_outer = true;
		}
		return true;
	}
	const chain = Object.assign(Object.create(Object.getPrototypeOf(node)), node) as NullAccessNode;
	const name = `_param_${status.var_name_counter.value++}`;
	const decl = new DeclarationNode(node.start, "private", "const", name, result_type, chain);
	if (!owned) decl.transferred_to_outer = true;
	status.allocations.push(decl);
	const read = new ValueNode(node.start, name, result_type);
	// An owned result may be handed over by a store (`y = xs?.copy()` —
	// check_heap_array_store turns the read into a move).
	read.is_owned_chain_temp = owned;
	for (const key of Object.keys(node)) delete (node as any)[key];
	Object.assign(node, read);
	Object.setPrototypeOf(node, Object.getPrototypeOf(read));
	return true;
}

/**
 * Hoist chain bases that would be evaluated more than once by the flatten's
 * hop tests: a base expression containing a call (`f()?.x`,
 * `p.find(id)?.y`), or a sub-chain whose method-call hop has further steps
 * (`a?.m()?.x` — the call would run once per outer test plus once for the
 * value). The hoisted temp is declared `const` and carries the checked
 * expression; the chain re-rooted at the temp is pure reads again.
 */
function hoist_single_evaluation_bases(node: NullAccessNode, status: CheckStatus): void {
	// (1) The base expression (everything left of the first `?.`) contains a
	// call: check it in place, hoist it, and re-root the chain at the temp.
	const base = chain_base_expr(node);
	if (base && base.node_type !== "value" && expr_contains_call(base)) {
		const old_allow_null = status.allow_null_value;
		status.allow_null_value = true;
		const ok = check_node(base, status);
		status.allow_null_value = old_allow_null;
		if (!ok) return;
		const t = type_from_value_node(base, status);
		const decl = new DeclarationNode(
			base.start,
			"private",
			"const",
			`_chain_${status.var_name_counter.value++}`,
			t,
			base,
		);
		status.allocations.push(decl);
		replace_chain_base(node, new ValueNode(base.start, decl.name, t));
		return;
	}
	// (2) The target is itself a chain containing a call hop (`a?.m()?.x`):
	// hoist the CHECKED sub-chain into a nullable temp — the outer hop tests
	// read the temp's flag instead of re-running the call.
	if (node.target.node_type === "null_access" && chain_contains_call(node.target)) {
		const sub = node.target as NullAccessNode;
		const old_allow_null = status.allow_null_value;
		status.allow_null_value = true;
		const ok = check_node(sub, status);
		status.allow_null_value = old_allow_null;
		if (!ok) return;
		const t = type_from_value_node(sub, status);
		const decl = new DeclarationNode(
			sub.start,
			"private",
			"const",
			`_chain_${status.var_name_counter.value++}`,
			t,
			sub,
		);
		status.allocations.push(decl);
		node.target = new ValueNode(sub.start, decl.name, t);
	}
}

/** The base expression of a chain: everything left of its first `?.`. */
function chain_base_expr(n: BaseNode): BaseNode | undefined {
	if (n.node_type === "grouped") {
		return chain_base_expr((n as unknown as { value: BaseNode }).value);
	}
	if (n.node_type === "null_access") return chain_base_expr((n as NullAccessNode).target);
	if (n.node_type === "access") {
		const an = n as AccessNode;
		// A method-call member ends the pure-read prefix — it IS the base.
		if (an.access.node_type !== "access_field") return n;
		return chain_base_expr(an.target);
	}
	return n;
}

/** Whether the chain rooted at `n` contains a method-call hop. */
function chain_contains_call(n: BaseNode): boolean {
	if (n.node_type === "null_access") {
		const na = n as NullAccessNode;
		if (na.access.node_type === "access_func") return true;
		return chain_contains_call(na.target);
	}
	if (n.node_type === "access" && (n as AccessNode).access.node_type === "access_field") {
		return chain_contains_call((n as AccessNode).target);
	}
	return false;
}

/** Whether an arbitrary expression contains a call (free function or
 *  method): the cheap conservative walk the base hoist keys on. */
function expr_contains_call(n: BaseNode): boolean {
	if (!n) return false;
	if (n.node_type === "func_call") return true;
	if (n.node_type === "grouped") {
		return expr_contains_call((n as unknown as { value: BaseNode }).value);
	}
	if (n.node_type === "access") {
		const an = n as AccessNode;
		if (an.access.node_type === "access_func") return true;
		return expr_contains_call(an.target);
	}
	if (n.node_type === "null_access") return true;
	return false;
}

/** Re-root a chain at `replacement`: swap the innermost target (the base
 *  expression) for the hoisted temp's value node. */
function replace_chain_base(n: BaseNode, replacement: ValueNode): void {
	if (n.node_type === "null_access") {
		const na = n as NullAccessNode;
		if (chain_base_expr(na) === na.target) {
			na.target = replacement;
			return;
		}
		replace_chain_base(na.target, replacement);
		return;
	}
	if (n.node_type === "access") {
		const an = n as AccessNode;
		replace_chain_base(an.target, replacement);
	}
}

function clone_type(t: Type): Type {
	const c = new Type(t.name, t.is_static, t.is_array, t.length);
	c.is_ref = t.is_ref;
	c.is_nullable = t.is_nullable;
	c.type_args = t.type_args;
	return c;
}
