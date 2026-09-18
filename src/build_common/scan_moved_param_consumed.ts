import BaseNode from "../nodes/BaseNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";

/**
 * Whether a `move` class parameter's ownership escapes the function body —
 * i.e. it is passed (as an argument or receiver) into some call/constructor
 * whose result may outlive the function (stored into a returned
 * container/struct), or it is a bare value used as an argument. In those cases
 * the callee must NOT destroy it at exit (it would double-free / leave a
 * dangling pointer in the escaping value). A bare reference that is only read
 * (e.g. field access `x.value` or interpolation) does NOT consume it.
 *
 * A method call ON the param (`x.foo(...)`) consumes it only when the callee
 * may retain its receiver: the method's body is scanned for receiver escape
 * (self passed as an argument, stored, returned, or dispatched into an
 * unresolvable/raw/spawning context). When the method provably does not
 * retain its receiver — or no receiver type / struct table is supplied — the
 * conservative "consumed" answer is kept. Trait-typed receivers have no
 * single resolvable body and stay conservative.
 *
 * Shared by the C backend's function epilogue and the aarch64 function /
 * method move-param reclaims so both agree on when a moved param is reclaimed.
 */
export function moved_param_is_consumed(
	root: FunctionNode,
	name: string,
	receiver_type?: string,
	structs?: StructNode[],
): boolean {
	// A raw `#arch` body is opaque to this scan — it may store the param into
	// an owning container (ClassBuffer.store_T/replace_T do exactly that), so
	// assume ownership escaped and let the body/callee manage the value.
	// Emitting the epilogue reclaim would free a pointer the raw body just
	// handed to its owner (a double free at the container's destroy).
	const statements = (root as unknown as { statements?: unknown[] }).statements ?? [];
	for (const stmt of statements) {
		if ((stmt as { node_type?: string })?.node_type === "raw") return true;
	}
	const state = { structs, in_progress: new WeakSet<FunctionNode>() };
	return scan_body(statements, name, receiver_type, state);
}

type ScanState = {
	structs?: StructNode[];
	in_progress: WeakSet<FunctionNode>;
};

function refs_name(n: unknown, name: string): boolean {
	return (
		!!n &&
		(n as BaseNode).node_type === "value" &&
		(n as unknown as { value?: string }).value === name
	);
}

function scan_body(
	statements: unknown[],
	name: string,
	receiver_type: string | undefined,
	state: ScanState,
): boolean {
	let consumed = false;
	const walk = (n: unknown): void => {
		if (!n || typeof n !== "object" || consumed) return;
		const node = n as Record<string, unknown>;
		if (node.node_type === "func_call") {
			for (const p of (node.params as unknown[]) ?? []) if (refs_name(p, name)) consumed = true;
		}
		if (node.node_type === "spawn" || node.node_type === "async_block") {
			// A spawned/async closure may outlive this body — any capture of
			// the tracked value transfers ownership beyond the epilogue.
			if (subtree_references(n, name)) consumed = true;
			return;
		}
		if (node.node_type === "func") {
			// A lambda captures values from this body into its closure env
			// (CLOSURE_PLAN). A move param captured by a closure transfers
			// ownership beyond the epilogue; a plain nested function cannot
			// reference it, so this only fires for closures.
			if ((n as { is_closure?: boolean }).is_closure && subtree_references(n, name)) {
				consumed = true;
			}
		}
		if (node.node_type === "access") {
			const access = node.access as
				| { node_type?: string; name?: string; params?: unknown[] }
				| undefined;
			if (access?.node_type === "access_func" && refs_name(node.target, name)) {
				if (receiver_escapes_through(access.name!, receiver_type, state)) {
					consumed = true;
				}
			}
			for (const p of access?.params ?? []) {
				if (refs_name(p, name)) consumed = true;
			}
		}
		if (node.node_type === "array") {
			for (const v of (node.values as unknown[]) ?? []) if (refs_name(v, name)) consumed = true;
		}
		if (node.node_type === "return" && refs_name(node.value, name)) consumed = true;
		if (node.node_type === "assign" && refs_name(node.right_value, name)) consumed = true;
		if (node.node_type === "declare" && refs_name(node.value, name)) consumed = true;
		for (const key of Object.keys(node)) {
			if (key === "node_type") continue;
			const v = node[key];
			if (Array.isArray(v)) {
				for (const item of v) walk(item);
			} else if (v && typeof v === "object") {
				walk(v);
			}
		}
	};
	for (const stmt of statements) walk(stmt);
	return consumed;
}

function subtree_references(root: unknown, name: string): boolean {
	let found = false;
	const walk = (n: unknown): void => {
		if (!n || typeof n !== "object" || found) return;
		const node = n as Record<string, unknown>;
		if (refs_name(n, name)) {
			found = true;
			return;
		}
		if (node.node_type === "access") {
			const access = node.access as { node_type?: string; name?: string } | undefined;
			if (access?.node_type === "access_func" && refs_name(node.target, name)) {
				found = true;
				return;
			}
		}
		for (const key of Object.keys(node)) {
			if (key === "node_type") continue;
			const v = node[key];
			if (Array.isArray(v)) {
				for (const item of v) walk(item);
			} else if (v && typeof v === "object") {
				walk(v);
			}
		}
	};
	walk(root);
	return found;
}

/**
 * Whether calling `<receiver>.<method_name>()` may retain the receiver:
 * true unless the method resolves (on the receiver's struct) to Nomen bodies
 * that provably never let `self` escape. Unresolvable receivers (traits,
 * unknown structs), missing methods, and raw/extern bodies are conservative.
 */
function receiver_escapes_through(
	method_name: string,
	receiver_type: string | undefined,
	state: ScanState,
): boolean {
	if (!receiver_type || !state.structs) return true;
	const struct = state.structs.find((s) => s.name === receiver_type);
	if (!struct) return true;
	const overloads = struct.functions.filter((f) => f.name === method_name);
	if (overloads.length === 0) return true;
	for (const func of overloads) {
		if (receiver_escapes(func, struct.name, state)) return true;
	}
	return false;
}

function receiver_escapes(
	func: FunctionNode,
	owner_struct_name: string,
	state: ScanState,
): boolean {
	if (!func.has_body) return true;
	if (func.statements.some((s) => s.node_type === "raw")) return true;
	if (state.in_progress.has(func)) return true;
	state.in_progress.add(func);
	const self_param = func.params.find((p) => p.is_self_param);
	const self_name = self_param?.name ?? "self";
	const escapes = scan_body(func.statements, self_name, owner_struct_name, state);
	state.in_progress.delete(func);
	return escapes;
}
