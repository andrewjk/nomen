import type BaseNode from "../nodes/BaseNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { is_string_borrow } from "./string_return_analysis.ts";

/**
 * Whether a RETURN-position tuple-literal STRING element already owns a heap
 * buffer of its own, so the return boundary can leave it raw (normalization
 * skips it). Two shapes qualify:
 *
 *  - a bare local that was TRANSFERRED into the tuple (`move`, or the
 *    last-use inference) whose buffer is genuinely heap — the callee's
 *    cleanup skips it, so the field owns the original allocation. A
 *    transferred RODATA local (a string literal on aarch64) does NOT
 *    qualify: the field would alias static storage and the caller's
 *    ownership of it would free static memory.
 *  - a fresh expression result that is not a borrow (a call, interpolation,
 *    concat) — it owns its heap already.
 *
 * Everything else (string literals, non-transferred locals, parameters,
 * borrow accessors such as `.at(0)`) must be strdup'd at the return so the
 * caller can uniformly own every string field of the returned tuple (see the
 * caller-side binding ownership).
 */
export default function tuple_return_owned_element(
	element: BaseNode,
	heap_strings: Set<string> | undefined,
): boolean {
	if (element.node_type === "value") {
		const v = (element as ValueNode).value ?? "";
		if (typeof v !== "string") return false;
		if (v.startsWith('"')) return false; // string literal → needs a copy
		if (!/^[A-Za-z_]/.test(v) || v === "null") return false;
		return !!(element as ValueNode).is_moved && !!heap_strings?.has(v);
	}
	// A fresh (non-borrow) call/expression result owns its heap already.
	return !is_string_borrow(element);
}
