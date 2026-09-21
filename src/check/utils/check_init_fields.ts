import add_error from "../../add_error.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type AssignmentNode from "../../nodes/AssignmentNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type StructNode from "../../nodes/StructNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";

const checked_structs = new WeakSet<StructNode>();

interface InitScan {
	/** Names of fields directly assigned via `self.<field> = ...`. */
	assigned: Set<string>;
	/**
	 * True when the body does something the AST walk can't see through — a raw
	 * `#arch` block, a method dispatched on bare `self`, or `self` passed to a
	 * call. Any of these may assign fields invisibly, so that init is exempt
	 * from the diagnostic rather than risk a false positive.
	 */
	opaque: boolean;
}

/**
 * Custom `#init` completeness check: every field without a declared default
 * must be assigned by every custom `#init` overload (mirroring the auto-init,
 * which takes a constructor parameter for exactly those fields). The instance
 * starts as raw malloc/stack garbage, so a skipped field holds garbage for the
 * instance's whole life — the scope-exit `<Class>_destroy` then frees a
 * garbage string pointer or destroys a garbage class pointer (invalid free /
 * crash), and even a benign scalar reads nondeterministic data.
 *
 * Deliberately conservative: an init whose body contains a raw block or
 * escapes through a bare-`self` method call / self-passing call is opaque to
 * the walk (e.g. Mutex's raw-C init, Map's `self.set` loop) and is exempt.
 * Fields assigned anywhere in a body — including inside if/loop branches —
 * count as assigned there; proving must-assign flow is left for later.
 *
 * `inits` is the struct's custom `#init` overloads (with bodies). For generic
 * structs it is the monomorphized clones. A field missing from any
 * non-opaque overload is reported once, at its declaration.
 */
export default function check_init_assigns_all_fields(
	struct: StructNode,
	inits: FunctionNode[],
	status: CheckStatus,
): void {
	if (!inits.length) return;
	// Monomorphize pushes the mono struct into the root's statements, so the
	// statement-order walk re-enters here for a struct the mono path already
	// checked. Diagnose each struct exactly once per compile.
	if (checked_structs.has(struct)) return;
	checked_structs.add(struct);
	const scans = inits.map((init) => {
		const scan: InitScan = { assigned: new Set(), opaque: false };
		for (const stmt of init.statements) {
			walk(stmt, scan, new WeakSet());
		}
		return scan;
	});
	for (const field of struct.fields) {
		// A defaulted field is seeded before the body runs (both backends).
		if (field.value) continue;
		const missed = scans.some((scan) => !scan.opaque && !scan.assigned.has(field.name));
		if (!missed) continue;
		add_error(
			status,
			`Field '${field.name}' is not assigned by '#init' and has no default`,
			field.start,
		);
	}
}

function is_bare_self(node: BaseNode): boolean {
	return node.node_type === "value" && (node as ValueNode).value === "self";
}

function is_init_field_assignment(node: BaseNode): node is AssignmentNode {
	if (node.node_type !== "assign") return false;
	const assign = node as AssignmentNode;
	// Only a plain `=` initializes: `+=` and friends read the field first, and
	// a `swap` exchange can store a garbage displaced value.
	if (assign.operator || assign.swap) return false;
	if (assign.left_value.node_type !== "access") return false;
	const access = assign.left_value as AccessNode;
	return access.access.node_type === "access_field" && is_bare_self(access.target);
}

function walk(node: BaseNode, scan: InitScan, visited: WeakSet<BaseNode>): void {
	if (!node || typeof node !== "object" || visited.has(node)) return;
	visited.add(node);
	if (node.node_type === "raw") {
		scan.opaque = true;
		return;
	}
	// Deferred bodies (nested funcs / lambdas, spawned tasks) don't run at
	// init time — don't descend, so assignments inside them never count.
	if (node.node_type === "func" || node.node_type === "spawn" || node.node_type === "async_block")
		return;
	if (is_init_field_assignment(node)) {
		scan.assigned.add(((node as AssignmentNode).left_value as AccessNode).access.name);
	}
	// `self.helper(...)` may assign any field — opaque. Method dispatch on a
	// FIELD (`self.items.grow(...)`) mutates contents, not the binding, so it
	// stays transparent.
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_func" && is_bare_self(access.target)) {
			scan.opaque = true;
			return;
		}
	}
	// A call passing bare `self` (e.g. a `fill(ref self)` helper) may assign
	// fields through a ref param — opaque.
	let call_params: BaseNode[] = [];
	if (node.node_type === "func_call") {
		call_params = (node as unknown as { params?: BaseNode[] }).params ?? [];
	} else if (node.node_type === "access") {
		const access = (node as AccessNode).access;
		if (access.node_type === "access_func") {
			call_params = (access as unknown as { params?: BaseNode[] }).params ?? [];
		}
	}
	if (call_params.some((param) => is_bare_self(param))) {
		scan.opaque = true;
		return;
	}
	for (const child of child_nodes(node)) {
		walk(child, scan, visited);
	}
}
