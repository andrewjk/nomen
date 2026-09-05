import { lower_function } from "./from_ast.ts";
import { is_identifier_like } from "./from_ast.ts";
import type { NirExpr, NirFunction, NirStmt } from "./nir.ts";

/**
 * Variable traffic analysis over NIR (see nir.ts). Answers every question
 * `plan_function_promotions` asks — who is read how often (raw +
 * loop-weighted), whose address escapes, which names are declared how many
 * times, and who gets passed to `ref` parameters — through ONE typed,
 * exhaustive walk of the lowered function instead of duck-typed AST scans.
 *
 * Counting semantics are intentionally IDENTICAL to the historical walkers
 * this replaces (assignment targets count one read; access-root and swap
 * receivers are marked address-taken; loop conditions/bodies/updates weigh
 * one nesting level hotter; arms and branches share their statement's
 * depth), verified by ported unit tests and generated-code diffs.
 */

/** Register-priority multiplier per enclosing loop level. */
const HOTNESS_PER_LEVEL = 8;
/** Nesting levels beyond which reads stop earning additional priority. */
const MAX_DEPTH = 4;

function hotness(depth: number): number {
	const capped = Math.min(depth, MAX_DEPTH);
	let w = 1;
	for (let i = 0; i < capped; i++) w *= HOTNESS_PER_LEVEL;
	return w;
}

export interface VariableTraffic {
	/** Unweighted identifier-read count. */
	reads: number;
	/** Reads weighted by enclosing-loop nesting (`reads * 8 ** depth`). */
	weighted_reads: number;
	address_taken: boolean;
}

export interface DeclEntry {
	name: string;
	type_name: string;
	modifiers: { is_array?: boolean; is_view?: boolean; is_ref?: boolean; is_nullable?: boolean };
}

export interface TrafficReport {
	variables: Map<string, VariableTraffic>;
	/** Every declaration occurrence anywhere in the lowered body (incl. nested). */
	decl_counts: Map<string, number>;
	/** Declarations in source order — planners filter for eligibility. */
	decls: DeclEntry[];
	/** Names passed as arguments to `ref` parameters somewhere in the body. */
	ref_arg_names: Set<string>;
}

interface CallFactsShape {
	readonly args: readonly NirExpr[];
	readonly ref_arg_indices: readonly number[];
	readonly swap_exprs: readonly NirExpr[];
}

class TrafficWalker {
	private readonly report: TrafficReport;

	constructor() {
		this.report = {
			variables: new Map(),
			decl_counts: new Map(),
			decls: [],
			ref_arg_names: new Set(),
		};
	}

	entry(name: string): VariableTraffic {
		let e = this.report.variables.get(name);
		if (!e) {
			e = { reads: 0, weighted_reads: 0, address_taken: false };
			this.report.variables.set(name, e);
		}
		return e;
	}

	count(name: string, depth: number, receiver: boolean): void {
		if (!is_identifier_like(name)) return;
		const e = this.entry(name);
		e.reads++;
		e.weighted_reads += hotness(depth);
		if (receiver) e.address_taken = true;
	}

	run(fn: NirFunction): TrafficReport {
		this.stmts(fn.body, 0);
		return this.report;
	}

	stmts(list: readonly NirStmt[], depth: number): void {
		for (const s of list) this.stmt(s, depth);
	}

	stmt(s: NirStmt, depth: number): void {
		switch (s.kind) {
			case "declare": {
				if (!s.decl.name) return;
				this.report.decl_counts.set(
					s.decl.name,
					(this.report.decl_counts.get(s.decl.name) ?? 0) + 1,
				);
				this.report.decls.push({
					name: s.decl.name,
					type_name: s.decl.type?.name ?? "",
					modifiers: s.decl.modifiers,
				});
				if (s.decl.init) this.expr(s.decl.init, depth, false);
				// `s.decl.swap` deliberately uncounted — same parity rule as the
				// assign case above.
				return;
			}
			case "assign":
				this.expr(s.target, depth, false);
				this.expr(s.rhs, depth, false);
				// `s.swap` is deliberately NOT walked: the historical func_flow
				// scan never saw assignment swap exprs, and promotion inputs
				// must stay byte-stable. (cfg.ts DOES count swap reads for
				// liveness, which has no emission consumer yet.)
				return;
			case "eval":
				this.expr(s.expr, depth, false);
				return;
			case "if":
				this.expr(s.cond, depth, false);
				this.stmts(s.then_branch, depth);
				this.stmts(s.else_branch, depth);
				return;
			case "while":
				this.expr(s.cond, depth + 1, false);
				this.stmts(s.body, depth + 1);
				if (s.update) this.stmt(s.update, depth + 1);
				return;
			case "for":
				this.count(s.item_name, depth + 1, false);
				if (s.list) this.expr(s.list, depth, false);
				this.stmts(s.body, depth + 1);
				if (s.update) this.stmt(s.update, depth + 1);
				return;
			case "switch_match":
				if (s.scrutinee) this.expr(s.scrutinee, depth, false);
				for (const arm of s.arms) {
					if (arm.condition) this.expr(arm.condition, depth, false);
					this.stmts(arm.branch, depth);
				}
				if (s.otherwise) this.stmts(s.otherwise, depth);
				return;
			case "return":
				if (s.value) this.expr(s.value, depth, false);
				return;
			case "break":
			case "continue":
			case "exit":
			case "raw":
			case "opaque":
				return;
			case "spawn":
				this.expr(s.call, depth, false);
				return;
			case "async_block":
				this.stmts(s.body, depth);
				return;
			case "anon_struct":
				for (const field of s.fields) this.expr(field.expr, depth, false);
				return;
			case "nested_func":
				this.stmts(s.body, depth);
				return;
			default: {
				const _exhaustive: never = s;
				void _exhaustive;
				return;
			}
		}
	}

	expr(e: NirExpr, depth: number, receiver: boolean): void {
		switch (e.kind) {
			case "leaf":
				if (e.name) this.count(e.name, depth, receiver);
				return;
			case "binary":
				this.expr(e.left, depth, false);
				this.expr(e.right, depth, false);
				return;
			case "wrap":
				if (e.inner) this.expr(e.inner, depth, false);
				return;
			case "call":
				this.call_facts(e.facts, depth);
				return;
			case "method_call":
				this.expr(e.receiver, depth, true);
				this.call_facts(e.facts, depth);
				return;
			case "path":
				this.expr(e.receiver, depth, true);
				return;
			case "flow":
				// Traffic flip (ASM_PLAN_4 item 4): flow scrutinee + arm
				// conditions + arm statements are REAL reads — the value's
				// consumer sees them every evaluation. Counting them makes
				// the allocators' read counts honest (a var read only in a
				// match arm was invisible and never promoted).
				if (e.scrutinee) this.expr(e.scrutinee, depth, false);
				for (const arm of e.arms) {
					if (arm.condition) this.expr(arm.condition, depth, false);
					this.stmts(arm.branch, depth);
				}
				if (e.otherwise) this.stmts(e.otherwise, depth);
				return;
			case "spawn":
				// Spawn arguments execute (on the task) and read their
				// inputs — counted like any call's arguments.
				this.expr(e.call, depth, false);
				return;
			case "other":
				return;
			default: {
				const _exhaustive: never = e;
				void _exhaustive;
				return;
			}
		}
	}

	call_facts(facts: CallFactsShape, depth: number): void {
		for (const arg of facts.args) this.expr(arg, depth, false);
		for (const i of facts.ref_arg_indices) {
			const arg = facts.args[i];
			if (arg?.kind === "leaf" && arg.name) this.report.ref_arg_names.add(arg.name);
		}
		for (const swapee of facts.swap_exprs) this.expr(swapee, depth, true);
	}
}

export function analyze_traffic(fn: NirFunction): TrafficReport {
	return new TrafficWalker().run(fn);
}

/** Convenience wrapper mirroring the pre-NIR entry point signature. */
export function analyze_function(func: Parameters<typeof lower_function>[0]): TrafficReport {
	return analyze_traffic(lower_function(func));
}
