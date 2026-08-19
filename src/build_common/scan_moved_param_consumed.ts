import BaseNode from "../nodes/BaseNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";

/**
 * Whether a `mov` class parameter's ownership escapes the function body —
 * i.e. it is passed (as an argument or receiver) into some call/constructor
 * whose result may outlive the function (stored into a returned
 * container/struct), or it is a bare value used as an argument. In those cases
 * the callee must NOT destroy it at exit (it would double-free / leave a
 * dangling pointer in the escaping value). A bare reference that is only read
 * (e.g. field access `x.value` or interpolation) does NOT consume it.
 *
 * Shared by the C backend's function epilogue and the aarch64 function /
 * method mov-param reclaims so both agree on when a mov'd param is reclaimed.
 */
export function moved_param_is_consumed(root: FunctionNode, name: string): boolean {
	let consumed = false;
	const refs_name = (n: unknown): boolean =>
		!!n &&
		(n as BaseNode).node_type === "value" &&
		(n as unknown as { value?: string }).value === name;
	const walk = (n: unknown): void => {
		if (!n || typeof n !== "object" || consumed) return;
		const node = n as Record<string, unknown>;
		if (node.node_type === "func_call") {
			for (const p of (node.params as unknown[]) ?? []) if (refs_name(p)) consumed = true;
		}
		if (node.node_type === "access") {
			// Method call on the param (`x.foo(...)`) — the receiver may be
			// stored by the callee, so treat as consuming.
			const access = node.access as { node_type?: string; params?: unknown[] } | undefined;
			if (access?.node_type === "access_func" && refs_name(node.target)) {
				consumed = true;
			}
			for (const p of access?.params ?? []) {
				if (refs_name(p)) consumed = true;
			}
		}
		if (node.node_type === "array") {
			for (const v of (node.values as unknown[]) ?? []) if (refs_name(v)) consumed = true;
		}
		if (node.node_type === "return" && refs_name(node.value)) consumed = true;
		if (node.node_type === "assign" && refs_name(node.right_value)) consumed = true;
		if (node.node_type === "declare" && refs_name(node.value)) consumed = true;
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
	for (const stmt of (root as unknown as { statements?: unknown[] }).statements ?? []) walk(stmt);
	return consumed;
}
