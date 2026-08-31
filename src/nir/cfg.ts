import type BaseNode from "../nodes/BaseNode.ts";
import type { NirCallFacts, NirExpr, NirFunction, NirStmt } from "./nir.ts";

/**
 * CFG construction over NIR (ASM_PLAN phase 4) — the liveness/dominance
 * substrate the NEON vectorizer and a future IR-based register allocator
 * build on (see analysis.ts for the passes that consume this shape).
 *
 * The statement tree lowers to flat basic blocks with explicit terminators:
 *
 * - `if` becomes a branch terminator plus then/else/join blocks. The join
 *   always exists (even when a branch is empty) so phi-style consumers have
 *   a home at every merge point.
 * - `while`/`for` become header/body/update/exit blocks. `continue` targets
 *   the update block (directly the header for update-less whiles); `break`
 *   targets the exit block; both are tracked on stacks around nesting.
 *   `for` headers carry a `loop_item` def (the per-iteration element write)
 *   and branch on a synthetic always-taken condition (exhaustion is checked
 *   by the iterator, invisible to IR).
 * - `switch`/`match` lower to a CHAIN of ordered condition branches — the
 *   same sequential-case semantics the backends emit. Each arm and the
 *   otherwise block jump to a shared join.
 * - `return`/`exit` (panic/todo) are terminators with no successors. Falling
 *   off the end of a statement list leaves the block `unreachable` — the
 *   backend appends the epilogue; no further IR statements exist after it.
 * - `nested_func` bodies do NOT inline into the enclosing flow (a nested
 *   declaration never executes at its declaration point): each becomes its
 *   own `FunctionCfg` under `nested`, analyzed recursively by consumers.
 * - `async_block` bodies DO inline (the conservative sequential model; the
 *   spawned work's dataflow is the program's own responsibility).
 * - `raw` blocks, `opaque` statements and unmapped `other` expressions are
 *   LIVENESS BARRIERS (`barrier: true`): they may touch any variable, so
 *   consumers treat their reads/defs as the entire variable universe.
 *
 * Variables are name-keyed, matching the backend's name-keyed
 * `stack_offsets`: shadowed declarations deliberately collapse onto one key
 * (the same conservative model the historical scans used). The `names`
 * array is the liveness universe: params first, then declarations in
 * emission order.
 */

interface FlatStmtBase {
	/** Original NIR statement's AST node. */
	readonly node: BaseNode;
	/** Identifier reads, in source order (may repeat). */
	readonly reads: readonly string[];
	/** Identifier may-defs: assignment targets, path roots, ref args, swap
	 *  swapees, method receivers — anything whose value the statement may
	 *  change. */
	readonly defs: readonly string[];
	/** True when the statement touches unknown state (raw asm, unmapped
	 *  constructs): reads/defs must be treated as the entire variable universe. */
	readonly barrier: boolean;
	/** True when evaluating this statement executes a call/method-call/spawn
	 *  somewhere in its expression trees — a register-allocation crossing
	 *  point (caller-saved registers die here). */
	readonly has_call: boolean;
}

export type FlatStmt =
	| (FlatStmtBase & { readonly op: "declare"; readonly name: string })
	| (FlatStmtBase & { readonly op: "assign"; readonly target: NirExpr; readonly rhs: NirExpr })
	| (FlatStmtBase & { readonly op: "eval"; readonly expr: NirExpr })
	| (FlatStmtBase & { readonly op: "spawn"; readonly call: NirExpr })
	| (FlatStmtBase & { readonly op: "anon_struct" })
	| (FlatStmtBase & { readonly op: "loop_item"; readonly name: string })
	| (FlatStmtBase & { readonly op: "raw"; readonly code: string })
	| (FlatStmtBase & { readonly op: "opaque" });

export type Terminator =
	| { readonly t: "goto"; readonly target: number }
	| {
			readonly t: "branch";
			/** Null cond = always taken (for-loop iterator check). */
			readonly cond: NirExpr | null;
			readonly if_true: number;
			readonly if_false: number;
			readonly reads: readonly string[];
			readonly barrier: boolean;
			readonly has_call: boolean;
	  }
	| {
			readonly t: "return";
			readonly value: NirExpr | null;
			readonly reads: readonly string[];
			readonly barrier: boolean;
			readonly has_call: boolean;
	  }
	| { readonly t: "exit"; readonly message: string | null }
	| { readonly t: "unreachable" };

export interface CfgBlock {
	readonly id: number;
	/** Effect statements in source order; the control decision is `term`. */
	readonly stmts: FlatStmt[];
	term: Terminator;
	succs: number[];
	preds: number[];
}

export interface FunctionCfg {
	readonly name: string;
	readonly label_name: string | undefined;
	readonly params: NirFunction["params"];
	/** Always block 0 (created before the body lowers). */
	readonly entry: number;
	readonly blocks: readonly CfgBlock[];
	/** Liveness universe: params then declarations, in emission order. */
	readonly names: readonly string[];
	/** Nested functions as their own CFGs (not part of the enclosing flow). */
	readonly nested: readonly FunctionCfg[];
	/** The ROOT function's lowering coverage set (nested lowering shares it). */
	readonly unknown_kinds: ReadonlySet<string>;
}

interface FactWalk {
	reads: string[];
	defs: string[];
	barrier: boolean;
	has_call: boolean;
}

function empty_walk(): FactWalk {
	return { reads: [], defs: [], barrier: false, has_call: false };
}

/** The identifier a path/method receiver chain bottoms out at, if any. */
function root_name(e: NirExpr): string | null {
	if (e.kind === "leaf") return e.name;
	if (e.kind === "path") return root_name(e.receiver);
	return null;
}

function walk_call_facts(facts: NirCallFacts, out: FactWalk): void {
	facts.args.forEach((arg, i) => {
		if (facts.ref_arg_indices.includes(i)) {
			const root = root_name(arg);
			if (root) out.defs.push(root);
			else out.barrier = true;
		}
		walk_expr(arg, out);
	});
	for (const swapee of facts.swap_exprs) {
		const root = root_name(swapee);
		if (root) out.defs.push(root);
		else out.barrier = true;
		walk_expr(swapee, out);
	}
}

function walk_expr(e: NirExpr | null | undefined, out: FactWalk): void {
	if (!e) return;
	switch (e.kind) {
		case "leaf":
			if (e.name) out.reads.push(e.name);
			return;
		case "binary":
			walk_expr(e.left, out);
			walk_expr(e.right, out);
			return;
		case "wrap":
			walk_expr(e.inner, out);
			return;
		case "call":
			out.has_call = true;
			walk_call_facts(e.facts, out);
			return;
		case "method_call":
			// The receiver is read AND may be written by the callee (struct
			// methods marshal a pointer). A may-def is always sound for
			// liveness; over-approximating only shortens no live range that
			// a later read would revive.
			out.has_call = true;
			walk_expr(e.receiver, out);
			{
				const root = root_name(e.receiver);
				if (root) out.defs.push(root);
			}
			walk_call_facts(e.facts, out);
			return;
		case "path":
			walk_expr(e.receiver, out);
			return;
		case "spawn":
			// Value-position `spawn f(x)`: the wrapped call's arguments are
			// read (and packed) when the task is created.
			out.has_call = true;
			walk_expr(e.call, out);
			return;
		case "flow":
			// Value-position control flow: every arm MAY execute, so each
			// condition's reads join the walk and each arm body's writes fold
			// in as may-defs (over-approximation is sound for liveness — it
			// only shortens no live range a later read would revive).
			if (e.scrutinee) walk_expr(e.scrutinee, out);
			for (const arm of e.arms) {
				if (arm.condition) walk_expr(arm.condition, out);
				for (const inner of arm.branch) stmt_facts(inner, out);
			}
			if (e.otherwise) for (const inner of e.otherwise) stmt_facts(inner, out);
			return;
		case "other":
			out.barrier = true;
			return;
		default: {
			const _exhaustive: never = e;
			void _exhaustive;
			return;
		}
	}
}

/**
 * Fact folding for STATEMENTS nested inside a value-position `flow`'s arms,
 * where the enclosing statement's flat facts must absorb them (there is no
 * CFG structure for the arm itself). Mirrors emit_stmt's declare/assign/eval
 * logic; structured control flow or raw escapes inside an arm are liveness
 * barriers.
 */
function stmt_facts(s: NirStmt, out: FactWalk): void {
	switch (s.kind) {
		case "eval":
			walk_expr(s.expr, out);
			return;
		case "declare": {
			if (s.decl.name) out.defs.push(s.decl.name);
			else out.barrier = true;
			if (s.decl.init) walk_expr(s.decl.init, out);
			if (s.decl.swap) walk_expr(s.decl.swap, out);
			return;
		}
		case "assign": {
			if (s.target.kind === "leaf") {
				if (s.target.name) {
					out.defs.push(s.target.name);
					if (s.operator) out.reads.push(s.target.name);
				} else out.barrier = true;
			} else if (s.target.kind === "path") {
				walk_expr(s.target, out);
				const root = root_name(s.target.receiver);
				if (root) out.defs.push(root);
				else out.barrier = true;
			} else {
				out.barrier = true;
			}
			walk_expr(s.rhs, out);
			if (s.swap) {
				const root = root_name(s.rhs);
				if (root) out.defs.push(root);
				else out.barrier = true;
				walk_expr(s.swap, out);
			}
			return;
		}
		default:
			// break/continue/return/exit/raw/spawn/async_block/nested_func/
			// anon_struct/opaque or structured flow inside a value arm:
			// conservative barrier.
			out.barrier = true;
			return;
	}
}

type CfgFnShape = Pick<NirFunction, "name" | "label_name" | "params" | "body">;

class CfgBuilder {
	private readonly blocks: CfgBlock[] = [];
	private readonly names: string[] = [];
	private readonly nested: FunctionCfg[] = [];
	/** Break → loop-exit block ids; continue → update/header block ids. */
	private readonly break_targets: number[] = [];
	private readonly continue_targets: number[] = [];
	/** Identifiers read anywhere — names without a declare/param still join
	 *  the liveness universe (checker-injected temps etc.). */
	private readonly read_names = new Set<string>();
	private cur: CfgBlock | null = null;

	constructor(private readonly coverage: ReadonlySet<string>) {}

	private new_block(): CfgBlock {
		const block: CfgBlock = {
			id: this.blocks.length,
			stmts: [],
			term: { t: "unreachable" },
			succs: [],
			preds: [],
		};
		this.blocks.push(block);
		return block;
	}

	private ensure_cur(): CfgBlock {
		if (!this.cur) this.cur = this.new_block();
		return this.cur;
	}

	private terminate(term: Terminator): void {
		if (term.t === "branch" || term.t === "return") this.track_reads(term.reads);
		this.ensure_cur().term = term;
		this.cur = null;
	}

	private push_flat(stmt: FlatStmt): void {
		this.track_reads(stmt.reads);
		this.ensure_cur().stmts.push(stmt);
	}

	private track_name(name: string): void {
		if (name) this.names.push(name);
	}

	private track_reads(reads: readonly string[]): void {
		for (const r of reads) this.read_names.add(r);
	}

	build(fn: CfgFnShape): FunctionCfg {
		this.ensure_cur(); // entry is always block 0
		for (const p of fn.params) this.track_name(p.name);
		this.emit_stmts(fn.body);
		if (this.cur) this.terminate({ t: "unreachable" });
		this.wire_edges();
		const seen = new Set(this.names);
		for (const r of this.read_names) {
			if (!seen.has(r)) {
				this.names.push(r);
				seen.add(r);
			}
		}
		return {
			name: fn.name,
			label_name: fn.label_name,
			params: fn.params,
			entry: 0,
			blocks: this.blocks,
			names: [...new Set(this.names)],
			nested: this.nested,
			unknown_kinds: this.coverage,
		};
	}

	private wire_edges(): void {
		for (const b of this.blocks) {
			const targets =
				b.term.t === "goto"
					? [b.term.target]
					: b.term.t === "branch"
						? [b.term.if_true, b.term.if_false]
						: [];
			b.succs = [...new Set(targets)];
		}
		for (const b of this.blocks) b.preds = [];
		for (const b of this.blocks)
			for (const s of b.succs) {
				const target = this.blocks[s];
				if (!target.preds.includes(b.id)) target.preds.push(b.id);
			}
	}

	private emit_stmts(list: readonly NirStmt[]): void {
		for (const s of list) this.emit_stmt(s);
	}

	private emit_stmt(s: NirStmt): void {
		switch (s.kind) {
			case "declare": {
				const out = empty_walk();
				const defs: string[] = s.decl.name ? [s.decl.name] : [];
				walk_expr(s.decl.init, out);
				if (s.decl.swap) {
					// `var X b = mov src.field swap <rep>`: the replacement's
					// reads join the walk, and the source root is redefined.
					if (s.decl.init) {
						const root = root_name(s.decl.init);
						if (root) defs.push(root);
						else out.barrier = true;
					} else {
						out.barrier = true;
					}
					walk_expr(s.decl.swap, out);
				}
				this.track_name(s.decl.name);
				this.push_flat({
					op: "declare",
					node: s.node,
					name: s.decl.name,
					reads: out.reads,
					defs,
					barrier: out.barrier,
					has_call: out.has_call,
				});
				return;
			}
			case "assign": {
				const out = empty_walk();
				const defs: string[] = [];
				if (s.target.kind === "leaf") {
					if (s.target.name) {
						defs.push(s.target.name);
						// A compound target's OLD value is read; a plain target
						// is a pure def (the old value dies here).
						if (s.operator) out.reads.push(s.target.name);
					} else out.barrier = true;
				} else if (s.target.kind === "path") {
					// A field write reads the base (its address) and rewrites
					// the base value struct.
					walk_expr(s.target, out);
					const root = root_name(s.target.receiver);
					if (root) defs.push(root);
					else out.barrier = true;
				} else {
					out.barrier = true;
				}
				walk_expr(s.rhs, out);
				if (s.swap) {
					// `a = b swap c`: the replacement is stored INTO the rhs
					// source, so the rhs's root is a may-def and the swap
					// expr's reads join the walk.
					const root = root_name(s.rhs);
					if (root) defs.push(root);
					else out.barrier = true;
					walk_expr(s.swap, out);
				}
				this.push_flat({
					op: "assign",
					node: s.node,
					target: s.target,
					rhs: s.rhs,
					reads: out.reads,
					defs,
					barrier: out.barrier,
					has_call: out.has_call,
				});
				return;
			}
			case "eval": {
				const out = empty_walk();
				walk_expr(s.expr, out);
				this.push_flat({
					op: "eval",
					node: s.node,
					expr: s.expr,
					reads: out.reads,
					defs: out.defs,
					barrier: out.barrier,
					has_call: out.has_call,
				});
				return;
			}
			case "spawn": {
				const out = empty_walk();
				walk_expr(s.call, out);
				this.push_flat({
					op: "spawn",
					node: s.node,
					call: s.call,
					reads: out.reads,
					defs: out.defs,
					barrier: out.barrier,
					has_call: out.has_call,
				});
				return;
			}
			case "anon_struct": {
				const out = empty_walk();
				for (const field of s.fields) walk_expr(field.expr, out);
				this.push_flat({
					op: "anon_struct",
					node: s.node,
					reads: out.reads,
					defs: out.defs,
					barrier: out.barrier,
					has_call: out.has_call,
				});
				return;
			}
			case "return": {
				const out = empty_walk();
				walk_expr(s.value, out);
				this.terminate({
					t: "return",
					value: s.value,
					reads: out.reads,
					barrier: out.barrier,
					has_call: out.has_call,
				});
				return;
			}
			case "break": {
				const target = this.break_targets[this.break_targets.length - 1];
				this.terminate(target === undefined ? { t: "unreachable" } : { t: "goto", target });
				return;
			}
			case "continue": {
				const target = this.continue_targets[this.continue_targets.length - 1];
				this.terminate(target === undefined ? { t: "unreachable" } : { t: "goto", target });
				return;
			}
			case "exit":
				this.terminate({ t: "exit", message: s.message });
				return;
			case "raw":
				this.push_flat({
					op: "raw",
					node: s.node,
					code: s.code,
					reads: [],
					defs: [],
					barrier: true,
					has_call: false,
				});
				return;
			case "opaque":
				this.push_flat({
					op: "opaque",
					node: s.node,
					reads: [],
					defs: [],
					barrier: true,
					has_call: false,
				});
				return;
			case "if": {
				const then_b = this.new_block();
				const else_b = this.new_block();
				const join_b = this.new_block();
				const out = empty_walk();
				walk_expr(s.cond, out);
				this.terminate({
					t: "branch",
					cond: s.cond,
					if_true: then_b.id,
					if_false: else_b.id,
					reads: out.reads,
					barrier: out.barrier,
					has_call: out.has_call,
				});
				this.cur = then_b;
				this.emit_stmts(s.then_branch);
				if (this.cur) this.terminate({ t: "goto", target: join_b.id });
				this.cur = else_b;
				this.emit_stmts(s.else_branch);
				if (this.cur) this.terminate({ t: "goto", target: join_b.id });
				this.cur = join_b;
				return;
			}
			case "while": {
				const header = this.new_block();
				const body_b = this.new_block();
				const exit_b = this.new_block();
				const cont = s.update ? this.new_block() : header;
				this.terminate({ t: "goto", target: header.id });
				const out = empty_walk();
				walk_expr(s.cond, out);
				this.cur = header;
				this.terminate({
					t: "branch",
					cond: s.cond,
					if_true: body_b.id,
					if_false: exit_b.id,
					reads: out.reads,
					barrier: out.barrier,
					has_call: out.has_call,
				});
				this.break_targets.push(exit_b.id);
				this.continue_targets.push(cont.id);
				this.cur = body_b;
				this.emit_stmts(s.body);
				this.break_targets.pop();
				this.continue_targets.pop();
				if (this.cur) this.terminate({ t: "goto", target: cont.id });
				if (s.update) {
					this.cur = cont;
					this.emit_stmt(s.update);
					if (this.cur) this.terminate({ t: "goto", target: header.id });
				}
				this.cur = exit_b;
				return;
			}
			case "for": {
				if (s.list) {
					const out = empty_walk();
					walk_expr(s.list, out);
					this.push_flat({
						op: "eval",
						node: s.list.node,
						expr: s.list,
						reads: out.reads,
						defs: out.defs,
						barrier: out.barrier,
						has_call: out.has_call,
					});
				}
				const header = this.new_block();
				const body_b = this.new_block();
				const update_b = this.new_block();
				const exit_b = this.new_block();
				this.terminate({ t: "goto", target: header.id });
				this.cur = header;
				if (s.item_name) {
					this.track_name(s.item_name);
					header.stmts.push({
						op: "loop_item",
						node: s.node,
						name: s.item_name,
						reads: [],
						defs: [s.item_name],
						barrier: false,
						has_call: false,
					});
				}
				this.terminate({
					t: "branch",
					cond: null,
					if_true: body_b.id,
					if_false: exit_b.id,
					reads: [],
					barrier: false,
					has_call: false,
				});
				this.break_targets.push(exit_b.id);
				this.continue_targets.push(update_b.id);
				this.cur = body_b;
				this.emit_stmts(s.body);
				this.break_targets.pop();
				this.continue_targets.pop();
				if (this.cur) this.terminate({ t: "goto", target: update_b.id });
				this.cur = update_b;
				if (s.update) this.emit_stmt(s.update);
				if (this.cur) this.terminate({ t: "goto", target: header.id });
				this.cur = exit_b;
				return;
			}
			case "switch_match": {
				if (s.scrutinee) {
					const out = empty_walk();
					walk_expr(s.scrutinee, out);
					this.push_flat({
						op: "eval",
						node: s.scrutinee.node,
						expr: s.scrutinee,
						reads: out.reads,
						defs: out.defs,
						barrier: out.barrier,
						has_call: out.has_call,
					});
				}
				const arm_blocks = s.arms.map(() => this.new_block());
				const join_b = this.new_block();
				const otherwise_b = s.otherwise ? this.new_block() : join_b;
				// Chain block 0 is the current block (scrutinee lives there);
				// one extra block per subsequent condition.
				const chain_blocks: CfgBlock[] = [this.ensure_cur()];
				for (let i = 1; i < s.arms.length; i++) chain_blocks.push(this.new_block());
				for (let i = 0; i < s.arms.length; i++) {
					const arm = s.arms[i];
					const next_b = i + 1 < s.arms.length ? chain_blocks[i + 1].id : otherwise_b.id;
					this.cur = chain_blocks[i];
					const out = empty_walk();
					if (arm.condition) {
						walk_expr(arm.condition, out);
						this.terminate({
							t: "branch",
							cond: arm.condition,
							if_true: arm_blocks[i].id,
							if_false: next_b,
							reads: out.reads,
							barrier: out.barrier,
							has_call: out.has_call,
						});
					} else {
						// Null-condition arm = always-taken default.
						this.terminate({ t: "goto", target: arm_blocks[i].id });
					}
					this.cur = arm_blocks[i];
					this.emit_stmts(arm.branch);
					if (this.cur) this.terminate({ t: "goto", target: join_b.id });
				}
				if (s.arms.length === 0) this.terminate({ t: "goto", target: otherwise_b.id });
				if (s.otherwise) {
					this.cur = otherwise_b;
					this.emit_stmts(s.otherwise);
					if (this.cur) this.terminate({ t: "goto", target: join_b.id });
				}
				this.cur = join_b;
				return;
			}
			case "async_block":
				this.emit_stmts(s.body);
				return;
			case "nested_func": {
				const sub = new CfgBuilder(this.coverage);
				this.nested.push(
					sub.build({
						name: s.name,
						label_name: s.label_name,
						params: [...s.params],
						body: s.body,
					}),
				);
				return;
			}
			default: {
				const _exhaustive: never = s;
				void _exhaustive;
				return;
			}
		}
	}
}

/** Flatten a lowered function into a control-flow graph. */
export function build_cfg(fn: NirFunction): FunctionCfg {
	return new CfgBuilder(fn.unknown_kinds).build(fn);
}
