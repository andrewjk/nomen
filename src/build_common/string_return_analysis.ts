import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type TraitNode from "../nodes/TraitNode.ts";
import { mono_type_name } from "./mono_name.ts";

/**
 * The type tables the string-return analysis needs. Both backends'
 * BuildStatus satisfy this shape.
 */
export interface StringAnalysisTable {
	structs: StructNode[];
	traits: TraitNode[];
}

const EMPTY_SET: Set<string> = new Set();

/**
 * Whether a function has any `return <expr>` statement in its body (used by
 * the C backend's gather, which registers every string-returning function
 * that actually returns — the backend strdup's borrows at the return site,
 * so ANY return hands the caller an owned heap copy).
 */
export function has_return_statement(func: FunctionNode): boolean {
	let has = false;
	const walk = (n: any): void => {
		if (!n || typeof n !== "object" || has) return;
		if (n.node_type === "return" && n.value) {
			has = true;
			return;
		}
		if (n.node_type === "func") return; // don't descend into nested funcs
		for (const k of Object.keys(n)) {
			if (k === "node_type") continue;
			const val = (n as any)[k];
			if (Array.isArray(val)) for (const item of val) walk(item);
			else if (val && typeof val === "object") walk(val);
		}
	};
	for (const stmt of func.statements ?? []) walk(stmt);
	return has;
}

/**
 * Names of string variables in `func` that hold a BORROW (a non-owned pointer)
 * for the duration of the function, not a fresh heap allocation: string
 * parameters, and string locals that are NEVER assigned a heap-producing value
 * (a function call, a non-borrow method call, or a string concatenation). A
 * `return <name>` of such a variable is a borrow return — the caller must NOT
 * free it. Used by value_is_owned_string to avoid mis-classifying bare-variable
 * returns as owned.
 *
 * A local initialized from a literal / borrow accessor / field is a borrow
 * candidate, but any reassignment that produces a heap value (e.g.
 * `result = result + sep`) makes it owned from that point on — so the variable
 * is scanned across its declaration AND all reassignments. Treating such a var
 * as a borrow would leak its final heap value (the caller wouldn't free it).
 */
export function borrow_string_names(func: FunctionNode): Set<string> {
	const borrow = new Set<string>();
	for (const param of func.params ?? []) {
		if (param.type?.name === "string" && !param.is_self_param) {
			borrow.add(param.name);
		}
	}
	const string_var_names = new Set<string>();
	const owned = new Set<string>();
	const isHeapRhs = (rhs: any): boolean => {
		if (!rhs) return false;
		const nt = rhs.node_type;
		if (nt === "op") return true;
		if (nt === "func_call") return true;
		if (nt === "access") {
			const acc = rhs.access;
			if (acc?.node_type === "access_func") {
				// Borrow accessors (`.at`/`.first`/`.slice`/`load_T` without
				// owned_return) yield a view into existing storage, not a fresh
				// heap allocation. Everything else (to_string, pop, ...) is heap.
				const isBorrowAccessor =
					!acc.owned_return &&
					(acc.name === "at" ||
						acc.name === "first" ||
						acc.name === "slice" ||
						acc.name === "load_T");
				return !isBorrowAccessor;
			}
			return false; // access_field → borrow
		}
		// Literal, bare-value alias, etc. → conservatively not heap (borrow).
		return false;
	};
	const visit = (n: any): void => {
		if (!n || typeof n !== "object") return;
		if (n.node_type === "declare" && n.type?.name === "string" && n.name) {
			string_var_names.add(n.name);
			if (isHeapRhs(n.value)) owned.add(n.name);
		} else if (n.node_type === "assign" && n.left_value?.node_type === "value" && !n.operator) {
			const name = n.left_value.value;
			if (string_var_names.has(name) && isHeapRhs(n.right_value)) owned.add(name);
		}
		if (n.node_type === "func") return; // don't descend into nested funcs
		for (const k of Object.keys(n)) {
			if (k === "node_type") continue;
			const val = (n as any)[k];
			if (Array.isArray(val)) for (const item of val) visit(item);
			else if (val && typeof val === "object") visit(val);
		}
	};
	for (const stmt of func.statements ?? []) visit(stmt);
	for (const name of string_var_names) {
		if (!owned.has(name)) borrow.add(name);
	}
	return borrow;
}

// Whether a returned expression produces a fresh owned heap string (that the
// caller must free), as opposed to a borrowed field, a variable, or a static
// string literal. Recurses through match/switch branches so a match returning
// only literals (e.g. `return match c { case 1 -> "A" ... }`) is NOT owned.
//
// `visiting` tracks methods currently being analyzed (by mangled key) to break
// cycles when a method returns another method that returns it.
//
// `borrow_names` is the set of string variable names in the function currently
// being analyzed that hold a BORROW (string parameters, and locals initialized
// from a borrow accessor / literal / another borrow). A `return <name>` of one
// of these is a borrow return, not an owned heap return — the caller must NOT
// free it. Without this, `func echo(string s, out string) { return s }` is
// mis-classified as heap-returning and the caller frees the borrowed pointer
// (crashing on a static literal / double-freeing the caller's storage).
export function value_is_owned_string(
	v: any,
	table: StringAnalysisTable,
	visiting?: Set<string>,
	borrow_names?: Set<string>,
): boolean {
	if (!visiting) visiting = new Set<string>();
	if (!borrow_names) borrow_names = EMPTY_SET;
	if (!v || typeof v !== "object") return false;
	if (v.node_type === "value") {
		// String literals are static storage (not owned). A bare variable
		// reference is owned only if it is a local holding a fresh heap
		// allocation — a parameter or a borrow-initialized local is a borrow.
		// A numeric literal (e.g. `return 0` for a missing key in a
		// string-returning function) is null, never a heap allocation.
		const isLiteral = typeof v.value === "string" && v.value.startsWith('"');
		const isNumeric = typeof v.value === "string" && /^(\+|-)?\d+$/.test(v.value);
		return !isLiteral && !isNumeric && !borrow_names.has(v.value);
	}
	if (v.node_type === "op") return true;
	if (v.node_type === "access") {
		if (v.access?.node_type === "access_field") return false;
		if (v.access?.node_type === "access_func") {
			const raw = v.access.name as string;
			const mangled = (v.access.mangled_name as string) || raw;
			if (mangled.startsWith("_string_interpolate_")) return true;
			if (mangled.endsWith("_to_string") && mangled !== "string_to_string") return true;
			if (raw === "to_string" && v.target?.type?.name && v.target.type.name !== "string")
				return true;
			// Container / buffer BORROW accessors return a view into the
			// receiver's existing storage — never a fresh heap allocation — so
			// the caller must NOT free the result. Mirrors the C backend's
			// `is_string_borrow` (at/first) and additionally covers the Buffer
			// slot-load primitives (`load_T`) that back List/Array `.at`.
			// Without this, a monomorphized `List<string>.at` (whose body is
			// `return self.items.load_T(i)`) is mis-classified as heap-returning
			// — `method_call_returns_owned` can't resolve `self.items` (its
			// access node carries no type after monomorphization), falls back to
			// the conservative "owned" below, and the caller frees the borrowed
			// char* (crashing on a static literal / double-freeing the slot).
			// A `mov out T` accessor (`owned_return`, e.g. `pop`) relinquishes
			// the slot and IS owned, so it is excluded.
			if (!v.access.owned_return) {
				if (raw === "at" || raw === "first" || raw === "slice" || raw === "load_T") {
					return false;
				}
			}
			// Resolve the method to its implementation(s) and classify by what
			// they actually return. Without this, a wrapper like
			// `func f = (Speaker s, out string) { return s.speak() }` is
			// conservatively marked heap-returning, so its caller frees the
			// result — but `speak` returns a borrow of an owning field
			// (`self.name`), so freeing it double-frees the field / frees a
			// static literal and crashes at cleanup.
			const resolved = method_call_returns_owned(v, table, visiting);
			if (resolved !== undefined) return resolved;
			// Unknown method: conservatively treat as owned (it may build a string).
			return true;
		}
		return false;
	}
	if (v.node_type === "func_call") {
		const raw = v.name as string;
		const mangled = (v.mangled_name as string) || raw;
		if (mangled.startsWith("_string_interpolate_")) return true;
		// A call to another function returning string: conservatively owned.
		return true;
	}
	if (v.node_type === "match" || v.node_type === "switch") {
		const branches: any[] = [];
		if (Array.isArray(v.cases)) for (const c of v.cases) if (c?.branch) branches.push(c.branch);
		if (v.else_branch) branches.push(v.else_branch);
		if (Array.isArray(v.branches)) for (const b of v.branches) branches.push(b);
		for (const b of branches) {
			const stmts = b?.statements ?? [];
			for (const s of stmts) {
				// Arrow branches (`-> expr`) wrap the result in a `let`; `=>`
				// branches wrap it in a `return`. Unwrap to the real expression.
				if (s?.node_type === "let" || s?.node_type === "return") {
					if (value_is_owned_string(s.value, table, visiting, borrow_names)) return true;
				} else if (value_is_owned_string(s, table, visiting, borrow_names)) {
					return true;
				}
			}
		}
		return false;
	}
	// Any other expression kind: conservatively owned.
	return true;
}

// Resolve a method-call access node (`receiver.method(...)`) to whether its
// result is an owned heap string, by inspecting the implementation body.
// Returns `undefined` when the target can't be resolved (caller falls back to
// a conservative guess).
function method_call_returns_owned(
	v: any,
	table: StringAnalysisTable,
	visiting: Set<string>,
): boolean | undefined {
	const method_name = v.access.name as string;
	const recv_type = type_from_value_node(v.target);
	const recv_name = recv_type?.name;
	if (!recv_name) return undefined;

	// Trait-typed receiver: dispatches to a conforming implementation, which
	// hands back the raw pointer it returns (aarch64 does not strdup at the
	// dispatch site). The result is owned only if EVERY conformer's method
	// returns an owned string; if any returns a borrow (or we can't tell),
	// treat as not-owned — never free, since freeing a borrow double-frees a
	// field. This matches the call-site behaviour in build_access_node, which
	// never marks a trait-dispatched result as heap.
	if (table.traits.find((t) => t.name === recv_name)) {
		const conformers = table.structs.filter((s) => s.traits.includes(recv_name));
		let found = false;
		let all_owned = true;
		for (const conf of conformers) {
			const m = (conf.functions ?? []).find((f) => f.name === method_name);
			if (!m || !(m as FunctionNode).has_body) continue;
			found = true;
			if (
				!function_returns_owned(m as FunctionNode, table, visiting, `${conf.name}_${method_name}`)
			) {
				all_owned = false;
				break;
			}
		}
		if (!found) return undefined;
		return all_owned;
	}

	// Concrete receiver: resolve the struct's method, accounting for
	// monomorphized names (e.g. `Foo<int>` → `Foo_int`).
	let struct_name = recv_name;
	if (recv_type.type_args?.length) {
		const mono = mono_type_name(recv_name, recv_type.type_args);
		if (table.structs.find((s) => s.name === mono)) struct_name = mono;
	}
	const struct = table.structs.find((s) => s.name === struct_name);
	if (struct) {
		const m = (struct.functions ?? []).find((f) => f.name === method_name);
		if (m && (m as FunctionNode).has_body) {
			return function_returns_owned(
				m as FunctionNode,
				table,
				visiting,
				`${struct_name}_${method_name}`,
			);
		}
	}
	return undefined;
}

/**
 * Whether a function/method has any `return` whose expression produces an
 * owned heap string. `key` is the mangled identity used for cycle protection.
 * Callers that have the FunctionNode at hand should also stamp the result on
 * it (`returns_string_borrow`) so the classification is node-readable once.
 */
export function function_returns_owned(
	func: FunctionNode,
	table: StringAnalysisTable,
	visiting: Set<string>,
	key: string,
): boolean {
	if (func.return_type?.name !== "string") return false;
	if (visiting.has(key)) return false;
	visiting.add(key);
	// Compute this function's borrow string names (params + borrow-initialized
	// locals) so `return <bare var>` of a borrow is classified correctly.
	const borrow_names = borrow_string_names(func);
	let has_owned_return = false;
	const walk = (n: any): void => {
		if (!n || typeof n !== "object") return;
		if (n.node_type === "return" && n.value) {
			if (value_is_owned_string(n.value, table, visiting, borrow_names)) has_owned_return = true;
		}
		if (n.node_type === "func") return;
		for (const k of Object.keys(n)) {
			if (k === "node_type") continue;
			const val = (n as any)[k];
			if (Array.isArray(val)) for (const item of val) walk(item);
			else if (val && typeof val === "object") walk(val);
		}
	};
	for (const stmt of func.statements ?? []) walk(stmt);
	visiting.delete(key);
	return has_owned_return;
}

/**
 * Whether a string-returning function's returns hand back a BORROW rather
 * than a fresh heap allocation (the shared classification behind the
 * `returns_string_borrow` node stamp). Non-string-returning functions
 * return false (the stamp is meaningless for them).
 */
export function function_returns_string_borrow(
	func: FunctionNode,
	table: StringAnalysisTable,
): boolean {
	return (
		func.return_type?.name === "string" &&
		!function_returns_owned(func, table, new Set<string>(), func.name)
	);
}
