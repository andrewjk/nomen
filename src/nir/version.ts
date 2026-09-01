import type { NirCallFacts, NirExpr, NirFunction, NirStmt } from "./nir.ts";

/**
 * Decl-site renaming over NIR (ASM_PLAN_2 tranche G stage 3).
 *
 * The name-keyed model collapses same-named declarations onto one liveness
 * key — sibling-loop consts (`const vv = …` in two loop bodies), shadowing
 * redeclares, same-named locals across if/else arms — and the allocator's
 * declared-exactly-once gate then excluded them all. This pass gives every
 * AMBIGUOUS declaration (a source name declared 2+ times anywhere in the
 * lowered body) its own key: the lowering's `decl.key` (`name@N` — `@` can
 * never appear in a source identifier). Reads resolve through a lexical
 * scope chain to the innermost binding's key, so each site gets its own
 * live range, its own interference edges, and its own register. Uniquely
 * declared names bind name→name and the whole view is IDENTICAL to the
 * original lowering — the byte-parity path.
 *
 * The renaming is a planning-time VIEW only: emission walks the original
 * NIR (whose declares carry `decl.key`) and binds the plan's register at
 * the declare site, keyed by the same deterministic keys.
 *
 * Hoisted allocation computes (checker-extracted `_param_N = <arg>` AST
 * nodes, invisible to the lowered exprs) are covered by attaching the
 * statement's scope snapshot as `hoist_scope`: cfg.ts's fold resolves the
 * computes' reads through it, so a hoisted read of `n` attributes to the
 * key of the `n` actually in scope at that statement rather than to a
 * same-named outer binding (which would shorten the real range and could
 * place a call-crossing variable in a caller-saved register — the stage-3
 * analog of the enablement receipt's invisible-read bug).
 */

/** Facts about one RENAMED declaration site. */
export interface VersionedSite {
	/** The source-level name (`vv`). */
	source: string;
	/** True when the declare lives inside a nested_func body (analyzed as
	 *  its own unit — never eligible in the enclosing function's plan). */
	nested: boolean;
}

export interface VersionedFunction {
	renamed: NirFunction;
	/** key → site facts for every RENAMED declare. */
	sites: Map<string, VersionedSite>;
}

class Scope {
	vars = new Map<string, string>();
	constructor(public readonly parent: Scope | undefined) {}

	lookup(name: string): string | undefined {
		const hit = this.vars.get(name);
		if (hit !== undefined) return hit;
		return this.parent?.lookup(name);
	}

	/** Innermost-wins flattening of the whole chain. */
	flatten(): Map<string, string> {
		const flat = this.parent ? this.parent.flatten() : new Map<string, string>();
		for (const [k, v] of this.vars) flat.set(k, v);
		return flat;
	}
}

class Versioner {
	private scope: Scope;
	private nested_depth = 0;

	constructor(
		private readonly multi: ReadonlySet<string>,
		private readonly sites: Map<string, VersionedSite>,
		params: readonly { readonly name: string }[],
	) {
		// Root scope: params bind identity (their keys ARE their names — the
		// prologue initializes them, they are never renamed).
		this.scope = new Scope(undefined);
		for (const p of params) this.scope.vars.set(p.name, p.name);
	}

	/** True when the AST node carries checker-hoisted allocation computes —
	 *  only those statements need a scope snapshot attached. */
	private static has_hoisted(node: unknown): boolean {
		const allocs = (node as { allocations?: unknown } | null | undefined)?.allocations;
		return Array.isArray(allocs) && allocs.length > 0;
	}

	private hoist_scope(node: unknown): ReadonlyMap<string, string> | undefined {
		return Versioner.has_hoisted(node) ? this.scope.flatten() : undefined;
	}

	private expr(e: NirExpr): NirExpr {
		switch (e.kind) {
			case "leaf":
				if (!e.name) return e;
				return { ...e, name: this.scope.lookup(e.name) ?? e.name };
			case "binary":
				return { ...e, left: this.expr(e.left), right: this.expr(e.right) };
			case "wrap":
				return { ...e, inner: e.inner ? this.expr(e.inner) : null };
			case "call":
				return { ...e, facts: this.facts(e.facts) };
			case "method_call":
				return { ...e, receiver: this.expr(e.receiver), facts: this.facts(e.facts) };
			case "path":
				return { ...e, receiver: this.expr(e.receiver) };
			case "spawn":
				return { ...e, call: this.expr(e.call) };
			case "flow":
				return {
					...e,
					scrutinee: e.scrutinee ? this.expr(e.scrutinee) : null,
					arms: e.arms.map((arm) => ({
						condition: arm.condition ? this.expr(arm.condition) : null,
						branch: this.stmts(arm.branch, new Scope(this.scope)),
					})),
					otherwise: e.otherwise ? this.stmts(e.otherwise, new Scope(this.scope)) : null,
				};
			case "other":
				return e;
		}
	}

	private facts(f: NirCallFacts): NirCallFacts {
		return {
			args: f.args.map((a) => this.expr(a)),
			ref_arg_indices: f.ref_arg_indices,
			swap_exprs: f.swap_exprs.map((s) => this.expr(s)),
		};
	}

	private stmts(list: readonly NirStmt[], scope: Scope): NirStmt[] {
		const saved = this.scope;
		this.scope = scope;
		try {
			return list.map((s) => this.stmt(s));
		} finally {
			this.scope = saved;
		}
	}

	run(body: readonly NirStmt[]): NirStmt[] {
		return this.stmts(body, this.scope);
	}

	private stmt(s: NirStmt): NirStmt {
		switch (s.kind) {
			case "declare": {
				// The initializer (and swap replacement) evaluate BEFORE the
				// declared name binds — `var x = x + 1` reads the OUTER x.
				const init = s.decl.init ? this.expr(s.decl.init) : null;
				const swap = s.decl.swap ? this.expr(s.decl.swap) : null;
				const hoist = this.hoist_scope(s.node);
				const renamed = this.multi.has(s.decl.name);
				const key = renamed ? s.decl.key : s.decl.name;
				if (renamed) {
					this.sites.set(key, { source: s.decl.name, nested: this.nested_depth > 0 });
				}
				this.scope.vars.set(s.decl.name, key);
				return {
					kind: "declare",
					node: s.node,
					hoist_scope: hoist,
					decl: { ...s.decl, name: key, key, init, swap },
				};
			}
			case "assign":
				return {
					kind: "assign",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					target: this.expr(s.target),
					rhs: this.expr(s.rhs),
					operator: s.operator,
					swap: s.swap ? this.expr(s.swap) : null,
				};
			case "eval":
				return {
					kind: "eval",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					expr: this.expr(s.expr),
				};
			case "spawn":
				return {
					kind: "spawn",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					call: this.expr(s.call),
				};
			case "anon_struct":
				return {
					kind: "anon_struct",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					fields: s.fields.map((f) => ({ expr: this.expr(f.expr) })),
				};
			case "return":
				return {
					kind: "return",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					value: s.value ? this.expr(s.value) : null,
				};
			case "break":
				return { kind: "break", node: s.node, hoist_scope: this.hoist_scope(s.node) };
			case "continue":
				return { kind: "continue", node: s.node, hoist_scope: this.hoist_scope(s.node) };
			case "exit":
				return {
					kind: "exit",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					message: s.message,
				};
			case "raw":
				return { kind: "raw", node: s.node, hoist_scope: this.hoist_scope(s.node), code: s.code };
			case "opaque":
				return { kind: "opaque", node: s.node, hoist_scope: this.hoist_scope(s.node) };
			case "if":
				return {
					kind: "if",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					cond: this.expr(s.cond),
					then_branch: this.stmts(s.then_branch, new Scope(this.scope)),
					else_branch: this.stmts(s.else_branch, new Scope(this.scope)),
				};
			case "while":
				// The condition and update evaluate in the ENCLOSING scope —
				// body declarations are not visible to either.
				return {
					kind: "while",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					cond: this.expr(s.cond),
					body: this.stmts(s.body, new Scope(this.scope)),
					update: s.update ? this.stmt(s.update) : null,
				};
			case "for": {
				// The item name is resolve-only (no declare binds it): when an
				// outer binding shares the name, item reads/defs join that
				// binding's key — the same conservative merge as before; a
				// fresh item name stays plain.
				const item_name = this.scope.lookup(s.item_name) ?? s.item_name;
				return {
					kind: "for",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					item_name,
					list: s.list ? this.expr(s.list) : null,
					body: this.stmts(s.body, new Scope(this.scope)),
					update: s.update ? this.stmt(s.update) : null,
				};
			}
			case "switch_match":
				return {
					kind: "switch_match",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					scrutinee: s.scrutinee ? this.expr(s.scrutinee) : null,
					arms: s.arms.map((arm) => ({
						condition: arm.condition ? this.expr(arm.condition) : null,
						branch: this.stmts(arm.branch, new Scope(this.scope)),
					})),
					otherwise: s.otherwise ? this.stmts(s.otherwise, new Scope(this.scope)) : null,
				};
			case "async_block":
				return {
					kind: "async_block",
					node: s.node,
					hoist_scope: this.hoist_scope(s.node),
					body: this.stmts(s.body, new Scope(this.scope)),
				};
			case "nested_func": {
				// The nested body closes over the enclosing scope (its reads of
				// outer names must land on the right keys) but its own params
				// and declares are its own unit — recorded `nested` so the
				// planner never grants them registers here.
				const child = new Scope(this.scope);
				for (const p of s.params) child.vars.set(p.name, p.name);
				this.nested_depth++;
				try {
					return {
						kind: "nested_func",
						node: s.node,
						hoist_scope: this.hoist_scope(s.node),
						name: s.name,
						label_name: s.label_name,
						params: s.params,
						body: this.stmts(s.body, child),
					};
				} finally {
					this.nested_depth--;
				}
			}
		}
	}
}

/**
 * Rename a lowered function's ambiguous declarations to their site keys.
 * `multi` holds every source name declared more than once anywhere in the
 * body (the caller derives it from the original traffic's `decl_counts`) —
 * names outside it bind identity, keeping the view byte-equal to `nir`.
 */
export function version_function(nir: NirFunction, multi: ReadonlySet<string>): VersionedFunction {
	const sites = new Map<string, VersionedSite>();
	const v = new Versioner(multi, sites, nir.params);
	return { renamed: { ...nir, body: v.run(nir.body) }, sites };
}
