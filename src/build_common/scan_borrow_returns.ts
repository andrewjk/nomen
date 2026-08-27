import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import StructNode from "../nodes/StructNode.ts";
import emission_label from "./emission_label.ts";

/**
 * Functions (and methods) whose CLASS-typed return value is a BORROWED
 * reference — e.g. `func box_at = (List<Box> xs, int i, out Box) { var Box
 * got = xs.at(j); return mov got }` hands back the container's element, not a
 * fresh instance. A caller-side declaration initialized from such a call must
 * NOT be destroy-tracked (the callee's owner frees it) — mirroring the
 * syntactic borrow rules at declaration sites (field access / non-`mov out`
 * method call).
 *
 * Syntactic, build-time: a return of a local whose initializer is a field
 * access or a non-owned-return method call (`.at()`, `.first()`, …) marks the
 * enclosing function. Mixed functions (some returns fresh, some borrowed) are
 * classified as borrowing — never freeing is safe (worst case a leak), while
 * the opposite risks a double-free.
 */
export function scan_borrow_returning_functions(root: BaseNode): Set<string> {
	const statements = (root as unknown as { statements: BaseNode[] }).statements ?? [];
	const class_type_names = new Set<string>();
	const result = new Set<string>();
	// One pass collects the class names (including classes nested inside the
	// parse_with_imports wrapper `main`), then a second classifies functions —
	// the second pass needs the complete class-name set up front.
	walk(
		statements,
		(n) => {
			if (n.node_type === "struct" && (n as StructNode).is_class) {
				class_type_names.add((n as StructNode).name);
			}
		},
		true,
		true,
	);
	walk(statements, (n) => {
		if (n.node_type === "struct") {
			// Methods are labelled `<Struct>_<name>`; their bodies are walked
			// by walk's struct boundary below.
			for (const f of (n as StructNode).functions ?? []) {
				scan_func(f as FunctionNode, (n as StructNode).name, result, class_type_names);
			}
		} else if (n.node_type === "func") {
			// Top-level / wrapper-nested functions (parse_with_imports nests a
			// whole program inside a synthetic `main`; the backends hoist the
			// nested funcs to file scope under their bare names).
			scan_func(n as FunctionNode, undefined, result, class_type_names);
		}
	});
	return result;
}

/**
 * Visit every AST node reachable from `value` — through arrays AND
 * single-node properties (an `if` node's branch blocks are node objects, not
 * statement arrays) — skipping `parent`/`scope` back-references. By default
 * does NOT descend INTO nested `func`/`struct`/`trait` declarations (a
 * function's own body must not leak into its enclosing function's
 * classification); `descend_boundaries` walks them too (used by the
 * class-name gather, which must see classes declared anywhere, including
 * inside the synthetic wrapper `main`).
 */
function walk(value: unknown, cb: (n: BaseNode) => void, top = true, descend_boundaries = false) {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) walk(item, cb, false, descend_boundaries);
		return;
	}
	const n = value as BaseNode;
	const is_boundary =
		(n.node_type === "func" || n.node_type === "struct" || n.node_type === "trait") && !top;
	if (typeof n.node_type === "string") cb(n);
	if (is_boundary && !descend_boundaries) return;
	for (const key of Object.keys(value as Record<string, unknown>)) {
		if (key === "parent" || key === "scope" || key === "node_type") continue;
		walk((value as Record<string, unknown>)[key], cb, false, descend_boundaries);
	}
}

function scan_func(
	func: FunctionNode,
	struct_name: string | undefined,
	result: Set<string>,
	class_type_names: Set<string>,
) {
	// Recurse into the body for NESTED function/struct declarations FIRST —
	// parse_with_imports wraps a whole program inside a synthetic `main`
	// (which itself has no return type), and the backends hoist nested funcs
	// to file scope under their bare names.
	walk(func.statements ?? [], (n) => {
		if (n.node_type === "func") {
			scan_func(n as FunctionNode, undefined, result, class_type_names);
		} else if (n.node_type === "struct") {
			for (const f of (n as StructNode).functions ?? []) {
				scan_func(f as FunctionNode, (n as StructNode).name, result, class_type_names);
			}
		}
	});
	if (!func.return_type?.name || !class_type_names.has(func.return_type.name)) return;
	// Collect this function's locals whose initializer is a syntactic borrow
	// of a class instance, and detect a `return <borrowed local>` anywhere in
	// the body (including inside nested if/while/match blocks).
	const borrowed_locals = new Set<string>();
	let returns_borrowed = false;
	walk(func.statements ?? [], (n) => {
		if (n.node_type === "declare") {
			const decl = n as DeclarationNode;
			if (!decl.type?.name || !class_type_names.has(decl.type.name)) return;
			const value = decl.value;
			if (!value || value.node_type !== "access") return;
			const access = value as AccessNode;
			if (access.access.node_type === "access_field") {
				borrowed_locals.add(decl.name);
			} else if (access.access.node_type === "access_func") {
				const fc = access.access as AccessFunctionCallNode;
				// A `mov out T` method (owned_return) produces a fresh
				// owned value; everything else hands back a reference the
				// receiver owns.
				if (!fc.owned_return) borrowed_locals.add(decl.name);
			}
		} else if (n.node_type === "return") {
			const value = (n as ReturnNode).value;
			if (
				value &&
				value.node_type === "value" &&
				borrowed_locals.has((value as unknown as { value: string }).value)
			) {
				returns_borrowed = true;
			}
		}
	});
	if (returns_borrowed) {
		// Mirror the build's emission label: a checker-assigned uniquified
		// label for a function nested in another body, else
		// `StructName_func_name` / the bare name.
		const label = func.label_name
			? emission_label(func)
			: struct_name
				? `${struct_name}_${func.name.replace(/#/g, "")}`
				: func.name.replace(/#/g, "");
		result.add(label);
	}
}
