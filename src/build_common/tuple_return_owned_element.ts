import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import emission_label from "./emission_label.ts";
import { is_string_borrow } from "./string_return_analysis.ts";

interface OwnershipContext {
	heap_strings?: Set<string>;
	heap_returning_functions?: Set<string>;
}

/** Statically heap-producing call names (the normalization name set). */
function is_heap_producing_name(name: string): boolean {
	if (name.startsWith("_string_interpolate_")) return true;
	if (name.endsWith("_to_string") && name !== "string_to_string") return true;
	return false;
}

/**
 * Whether a RETURN-position tuple-literal STRING element already owns a heap
 * buffer of its own, so the return boundary can leave it raw (normalization
 * skips it). Qualifying shapes:
 *
 *  - a bare local TRANSFERRED into the tuple (`mv`, or the last-use
 *    inference) whose buffer is genuinely heap — the callee's cleanup skips
 *    it, so the field owns the original allocation. A transferred RODATA
 *    local (a string literal on aarch64) does NOT qualify: the field would
 *    alias static storage and the caller's ownership would free static memory.
 *  - a free-call result whose callee is classified HEAP-returning (the
 *    scan's return-site heap producers, the name-based interpolation /
 *    `*_to_string` builtins, and `mv out string` signatures). A call to a
 *    BORROW-classified callee (a literal-returning function) does NOT own —
 *    treating it as owned made the field teardown free rodata
 *    (`var t = [1, make_str()]`).
 *  - a non-borrow container accessor/method result (methods normalize every
 *    string return to heap) and heap expressions (concat/repeat).
 *
 * Everything else (string literals, non-transferred locals, parameters,
 * borrow accessors such as `.at(0)`) must be strdup'd at the return so the
 * caller can uniformly own every string field of the returned tuple (see the
 * caller-side binding ownership).
 */
export default function tuple_return_owned_element(
	element: BaseNode,
	context: OwnershipContext | Set<string> | undefined,
	expr_owned = false,
): boolean {
	// Backwards-compatible: a bare Set is the heap_strings set.
	const ctx: OwnershipContext =
		context instanceof Set ? { heap_strings: context } : (context ?? {});
	if (element.node_type === "value") {
		const v = (element as ValueNode).value ?? "";
		if (typeof v !== "string") return false;
		if (v.startsWith('"')) return false; // string literal → needs a copy
		if (!/^[A-Za-z_]/.test(v) || v === "null") return false;
		return !!(element as ValueNode).is_moved && !!ctx.heap_strings?.has(v);
	}
	// The C backend blanket-strdups every string return, so EVERY non-value
	// expression element is already heap-owned there (its remit passes
	// `expr_owned`).
	if (expr_owned) return true;
	if (element.node_type === "func_call") {
		const call = element as FunctionCallNode;
		if (is_heap_producing_name(String(call.name ?? ""))) return true;
		if (call.resolved_function?.returns_move) return true;
		const label = emission_label(call.resolved_function ?? ({ name: call.name } as never));
		return !!ctx.heap_returning_functions?.has(String(label ?? ""));
	}
	if (element.node_type === "op") {
		const op = element as unknown as { op?: string; type?: { name?: string } };
		return (op.op === "+" || op.op === "*") && op.type?.name === "string";
	}
	if (element.node_type === "access") {
		// Methods normalize their string returns to heap, so a non-borrow
		// accessor/method result is owned; the call-site borrow accessors
		// (`.at`/`.first`/`.slice`/`load_*`) stay borrows.
		return !is_string_borrow(element as unknown as AccessNode);
	}
	return false;
}
