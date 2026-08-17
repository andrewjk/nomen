import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type TraitNode from "../nodes/TraitNode.ts";
import { mono_type_name } from "./mono_name.ts";

/**
 * The type tables the string-return analysis needs. Both backends'
 * BuildStatus satisfies this shape.
 */
export interface StringAnalysisTable {
	structs: StructNode[];
	traits: TraitNode[];
	/** Functions/methods whose string return is a fresh owned heap allocation
	 *  the caller frees (populated by each backend's gather pass). */
	heap_returning_functions?: Set<string>;
}

const EMPTY_SET: Set<string> = new Set();

/**
 * The container/buffer BORROW accessor family — method calls that return a
 * view into the receiver's existing storage rather than a fresh value:
 * `.at(i)`, `.first()`, `.slice(...)`, and the backing Buffer slot-load
 * primitive `load_T`. A `mov out T` accessor (`owned_return`, e.g. `pop` /
 * `move_T`) relinquishes the slot and is NOT in this family.
 */
export function is_container_borrow_accessor_name(name: string): boolean {
	return name === "at" || name === "first" || name === "slice" || name === "load_T";
}

/**
 * Whether `fn_name` is one of the borrow accessors whose CALL SITES treat
 * the string result as a non-owned borrow (mirroring the C backend's
 * `is_string_borrow`, which recognizes exactly `.at`/`.first`). Inside such
 * a function's own body a returned container borrow stays a borrow; inside
 * any other function it is normalized into an owned copy at the return
 * site (see build_return_node), so it counts as owned for classification.
 */
export function is_call_site_borrow_accessor(fn_name: string | undefined): boolean {
	return fn_name === "at" || fn_name === "first";
}

/**
 * Whether `node` is a container/buffer borrow accessor CALL (an
 * `access_func` named `.at`/`.first`/`.slice`/`load_T` without
 * `owned_return`) — the value it produces is a borrow of the receiver's
 * storage, not a fresh allocation.
 */
export function is_container_borrow_access(node: any): boolean {
	return (
		!!node &&
		node.node_type === "access" &&
		node.access?.node_type === "access_func" &&
		!node.access.owned_return &&
		is_container_borrow_accessor_name(node.access.name)
	);
}

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
 *
 * A local whose DECLARATION initializer is a container-borrow accessor
 * (`.at(i)`/`.first()`/…, per `is_container_borrow_accessor_name`) is a borrow
 * only inside the call-site borrow accessors' own bodies (`at`/`first`).
 * Anywhere else the borrow is normalized when it escapes (the return site
 * strdup's it into an owned copy for the caller), so the variable counts as
 * owned for return classification. Only the declaration init is reclassified:
 * a borrow RE-assignment (`t = ys.at(1)` after a literal init) keeps the
 * variable a borrow, matching the return-site emission decision.
 */
export function borrow_string_names(func: FunctionNode): Set<string> {
	const borrow = new Set<string>();
	for (const param of func.params ?? []) {
		if (param.type?.name === "string" && !param.is_self_param) {
			borrow.add(param.name);
		}
	}
	const fn_is_borrow_accessor = is_call_site_borrow_accessor(func.name);
	const string_var_names = new Set<string>();
	const owned = new Set<string>();
	const isHeapRhs = (rhs: any, decl_init: boolean): boolean => {
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
				const isBorrowAccessor = !acc.owned_return && is_container_borrow_accessor_name(acc.name);
				if (isBorrowAccessor) {
					return !fn_is_borrow_accessor && decl_init;
				}
				return true;
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
			if (isHeapRhs(n.value, true)) owned.add(n.name);
		} else if (n.node_type === "assign" && n.left_value?.node_type === "value" && !n.operator) {
			const name = n.left_value.value;
			if (string_var_names.has(name) && isHeapRhs(n.right_value, false)) owned.add(name);
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
//
// `enclosing_fn` is the name of the function whose body the expression belongs
// to. A container/borrow accessor call (`.at`/`.first`/`.slice`/`load_T`)
// counts as a borrow ONLY inside the call-site borrow accessors' own bodies
// (`at`/`first`, whose call sites treat the result as a non-owned borrow);
// returned from any other function it is normalized into an owned copy at the
// return site (the aarch64 backend strdup's it, mirroring the C backend's
// boundary-strdup), so it counts as owned here.
export function value_is_owned_string(
	v: any,
	table: StringAnalysisTable,
	visiting?: Set<string>,
	borrow_names?: Set<string>,
	enclosing_fn?: string,
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
			// receiver's existing storage — never a fresh heap allocation.
			// Inside the accessor methods' OWN bodies (`at`/`first`, e.g. a
			// monomorphized `List<string>.at` whose body is `return
			// self.items.load_T(i)`) the result stays a borrow: call sites of
			// `.at`/`.first` treat it as non-owned and never free it (mirrors
			// the C backend's `is_string_borrow`), and the unresolved-receiver
			// fallback below must not mis-classify it as heap either. Returned
			// from any OTHER function, the borrow is normalized at the return
			// site (strdup'd into an independent copy for the caller — the
			// same contract as the C backend), so it counts as OWNED here and
			// the function is classified heap-returning.
			// A `mov out T` accessor (`owned_return`, e.g. `pop`) relinquishes
			// the slot and IS owned, so it is excluded.
			if (!v.access.owned_return && is_container_borrow_accessor_name(raw)) {
				return !is_call_site_borrow_accessor(enclosing_fn);
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
					if (value_is_owned_string(s.value, table, visiting, borrow_names, enclosing_fn))
						return true;
				} else if (value_is_owned_string(s, table, visiting, borrow_names, enclosing_fn)) {
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
	// A `view` return (e.g. `List<T>.slice`'s `out view T`) is the universal
	// (ptr, len) struct, not a heap string — never heap-returning.
	if (func.return_type?.name !== "string" || func.return_type?.is_view) return false;
	if (visiting.has(key)) return false;
	visiting.add(key);
	// Compute this function's borrow string names (params + borrow-initialized
	// locals) so `return <bare var>` of a borrow is classified correctly.
	const borrow_names = borrow_string_names(func);
	let has_owned_return = false;
	const walk = (n: any): void => {
		if (!n || typeof n !== "object") return;
		if (n.node_type === "return" && n.value) {
			if (value_is_owned_string(n.value, table, visiting, borrow_names, func.name))
				has_owned_return = true;
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
	if (func.return_type?.name !== "string" || func.return_type?.is_view) return false;
	return !function_returns_owned(func, table, new Set<string>(), func.name);
}

/**
 * Collect the value expressions a match/switch/if-expression's branches assign
 * to the join target — each `-> expr` / `let expr` branch's LetNode value, plus
 * any explicit `return expr` inside `=>`/block-form branches.
 */
export function collect_expression_branch_values(node: any): any[] {
	const out: any[] = [];
	const visit_block = (block: any): void => {
		for (const stmt of block?.statements ?? []) {
			if (stmt?.node_type === "let") {
				out.push(stmt.value);
			} else if (stmt?.node_type === "return" && stmt.value) {
				out.push(stmt.value);
			}
		}
	};
	if (!node || typeof node !== "object") return out;
	if (node.node_type === "match") {
		for (const match_case of node.cases ?? []) visit_block(match_case?.branch);
		visit_block(node.else_branch);
	} else if (node.node_type === "switch") {
		for (const switch_case of node.cases ?? []) visit_block(switch_case?.branch);
		visit_block(node.else_branch);
	} else if (node.node_type === "if") {
		visit_block(node.if_branch);
		visit_block(node.else_branch);
	}
	return out;
}

/**
 * Whether a match/switch/if-expression branch value produces a fresh OWNED
 * heap string — an allocation the join variable can free at scope exit — as
 * opposed to something that must be strdup'd into an owned copy before the
 * join variable can own it (a string literal in static storage, a numeric
 * literal lowering to NULL, a bare variable whose own declaration owns its
 * value, a struct field borrow, or a container-borrow accessor like
 * `.at(i)`/`.first()` returning a view into the receiver's storage).
 *
 * Used to normalize MIXED joins (some branches owned, some not): when any
 * branch is owned, the non-owned branch values are strdup'd at their
 * assignment so the join variable uniformly owns its result and can be freed
 * once at scope exit / returned without a join-point strdup.
 */
export function is_owned_string_branch_value(node: any, table: StringAnalysisTable): boolean {
	if (!node || typeof node !== "object") return false;
	if (node.node_type === "value") {
		// Literals (static storage), numerics (NULL), and bare variables
		// (owned by their own declarations) all need a copy to be owned here.
		return false;
	}
	if (node.node_type === "op") return true; // string concat/repeat allocate
	if (node.node_type === "grouped") return is_owned_string_branch_value(node.value, table);
	if (node.node_type === "match" || node.node_type === "switch" || node.node_type === "if") {
		// A nested expression join assigns its branches to the same target; it
		// is owned if any of its branches is (it is itself normalized).
		return collect_expression_branch_values(node).some((v) =>
			is_owned_string_branch_value(v, table),
		);
	}
	if (node.node_type === "func_call") {
		const name = (node.mangled_name as string) || (node.name as string) || "";
		if (name.startsWith("_string_interpolate_")) return true;
		return !!table.heap_returning_functions?.has(name);
	}
	if (node.node_type === "access") {
		const access = node.access;
		if (!access) return false;
		if (access.node_type === "access_field") return false; // struct storage
		if (access.node_type === "access_func") {
			if (access.owned_return) return true;
			const mangled = (access.mangled_name as string) || (access.name as string) || "";
			if (mangled.startsWith("_string_interpolate_")) return true;
			if (access.name === "to_string" && mangled !== "string_to_string") return true;
			// A container/buffer borrow accessor yields a view into the
			// receiver's storage — never a fresh allocation.
			if (!access.owned_return && is_container_borrow_accessor_name(access.name)) return false;
			if (table.heap_returning_functions?.has(mangled)) return true;
			// Unresolved method: delegate to the shared method-resolution
			// analysis (conservatively owned).
			return value_is_owned_string(node, table, new Set<string>(), EMPTY_SET, undefined);
		}
		return false;
	}
	return false;
}
