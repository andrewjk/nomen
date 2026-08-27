import type { CfgBlock, FunctionCfg } from "./cfg.ts";

/**
 * Dataflow analyses over the NIR CFG (see cfg.ts): classic may-liveness,
 * iterative dominator sets + immediate dominators + dominance frontiers,
 * and natural-loop discovery from back edges. These are the passes the
 * NEON vectorizer and a future IR-based register allocator stand on
 * (ASM_PLAN phase 4) — all name-keyed, all conservative at barriers.
 *
 * Unreachable blocks (dead code after `return`, join blocks both branches
 * exited early) are excluded from every fixpoint and from the dominator
 * tree; `reachable_blocks` exposes them for consumers that care.
 */

export function reachable_blocks(cfg: FunctionCfg): boolean[] {
	const seen: boolean[] = Array.from({ length: cfg.blocks.length }, () => false);
	const stack = [cfg.entry];
	seen[cfg.entry] = true;
	while (stack.length) {
		const b = stack.pop()!;
		for (const s of cfg.blocks[b].succs) {
			if (!seen[s]) {
				seen[s] = true;
				stack.push(s);
			}
		}
	}
	return seen;
}

/** Reverse postorder over reachable blocks — entry first, ideal for forward
 *  dataflow (backward passes iterate it in reverse). */
export function reverse_postorder(cfg: FunctionCfg): number[] {
	const visited: boolean[] = Array.from({ length: cfg.blocks.length }, () => false);
	const post: number[] = [];
	const stack: { id: number; succ: number }[] = [{ id: cfg.entry, succ: 0 }];
	visited[cfg.entry] = true;
	while (stack.length) {
		const top = stack[stack.length - 1];
		const succs = cfg.blocks[top.id].succs;
		if (top.succ < succs.length) {
			const s = succs[top.succ++];
			if (!visited[s]) {
				visited[s] = true;
				stack.push({ id: s, succ: 0 });
			}
		} else {
			post.push(top.id);
			stack.pop();
		}
	}
	return post.reverse();
}

export interface LivenessResult {
	/** Variables live on ENTRY to each block (read before any def). */
	live_in: Set<string>[];
	/** Variables live on EXIT of each block (read along some successor path). */
	live_out: Set<string>[];
}

function block_uses_defs(
	b: CfgBlock,
	universe: ReadonlySet<string>,
): { use: Set<string>; def: Set<string> } {
	const use = new Set<string>();
	const def = new Set<string>();
	const consider = (reads: readonly string[], barrier: boolean): void => {
		if (barrier) {
			for (const v of universe) if (!def.has(v)) use.add(v);
			return;
		}
		for (const r of reads) if (!def.has(r)) use.add(r);
	};
	// Forward: a read is upward-exposed (belongs in `use`) exactly when no
	// earlier statement in the block defined it. The terminator's condition
	// reads come after every statement.
	for (const s of b.stmts) {
		consider(s.reads, s.barrier);
		for (const d of s.defs) def.add(d);
	}
	switch (b.term.t) {
		case "branch":
			consider(b.term.reads, b.term.barrier);
			break;
		case "return":
			consider(b.term.reads, b.term.barrier);
			break;
		default:
			break;
	}
	return { use, def };
}

/** Classic backward may-liveness. Ref args, swap swapees, method receivers
 *  and path-assignment roots are may-defs (the callee/write may change the
 *  value), so liveness breaks exactly where values can change. */
export function analyze_liveness(cfg: FunctionCfg): LivenessResult {
	const universe = new Set<string>(cfg.names);
	const n = cfg.blocks.length;
	const live_in: Set<string>[] = Array.from({ length: n }, () => new Set());
	const live_out: Set<string>[] = Array.from({ length: n }, () => new Set());
	const uses: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
	const defs: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
	for (const b of cfg.blocks) {
		const { use, def } = block_uses_defs(b, universe);
		uses[b.id] = use;
		defs[b.id] = def;
	}
	// Sets only grow, so size compares detect the fixpoint.
	const order = reverse_postorder(cfg).reverse();
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of order) {
			const out = live_out[id];
			const out_before = out.size;
			for (const s of cfg.blocks[id].succs) {
				for (const v of live_in[s]) out.add(v);
			}
			const in_set = live_in[id];
			const in_before = in_set.size;
			for (const u of uses[id]) in_set.add(u);
			for (const v of out) if (!defs[id].has(v)) in_set.add(v);
			if (out.size !== out_before || in_set.size !== in_before) changed = true;
		}
	}
	return { live_in, live_out };
}

export interface DominanceResult {
	reachable: boolean[];
	/** Reverse postorder over reachable blocks. */
	rpo: number[];
	/** Full dominator sets (reachable blocks only; entry → {entry}). */
	dom: Set<number>[];
	/** Immediate dominator per reachable block (-1 for entry/unreachable). */
	idom: number[];
	/** Dominator-tree children (in RPO discovery order). */
	children: number[][];
	/** Dominance frontiers (reachable blocks only). */
	frontier: number[][];
}

export function analyze_dominance(cfg: FunctionCfg): DominanceResult {
	const reachable = reachable_blocks(cfg);
	const rpo = reverse_postorder(cfg);
	const n = cfg.blocks.length;
	const dom: Set<number>[] = Array.from({ length: n }, () => new Set());
	for (let i = 0; i < n; i++) {
		if (!reachable[i]) continue;
		for (let j = 0; j < n; j++) if (reachable[j]) dom[i].add(j);
	}
	dom[cfg.entry] = new Set([cfg.entry]);
	// Sets only shrink from the full initialization, so size compares
	// detect the fixpoint.
	let changed = true;
	while (changed) {
		changed = false;
		for (const b of rpo) {
			if (b === cfg.entry) continue;
			let inter: Set<number> | null = null;
			for (const p of cfg.blocks[b].preds) {
				if (!reachable[p]) continue;
				if (!inter) {
					inter = new Set(dom[p]);
					continue;
				}
				const drop: number[] = [];
				for (const v of inter) if (!dom[p].has(v)) drop.push(v);
				for (const v of drop) inter.delete(v);
			}
			const fresh = inter ?? new Set<number>();
			fresh.add(b);
			if (fresh.size !== dom[b].size) {
				dom[b] = fresh;
				changed = true;
			}
		}
	}
	const idom: number[] = Array.from({ length: n }, () => -1);
	const children: number[][] = Array.from({ length: n }, () => []);
	for (const b of rpo) {
		if (b === cfg.entry) continue;
		const cands = [...dom[b]];
		cands.splice(cands.indexOf(b), 1);
		// The unique candidate whose dominator set is exactly the candidate
		// set — the closest strict dominator.
		const id = cands.find((c) => dom[c].size === cands.length) ?? -1;
		idom[b] = id;
		if (id !== -1) children[id].push(b);
	}
	const frontier: number[][] = Array.from({ length: n }, () => []);
	for (let b = 0; b < n; b++) {
		if (!reachable[b]) continue;
		const preds = cfg.blocks[b].preds.filter((p) => reachable[p]);
		if (preds.length < 2) continue;
		for (const p of preds) {
			let runner = p;
			let guard = n + 1;
			while (runner !== idom[b] && runner !== -1 && guard-- > 0) {
				if (!frontier[runner].includes(b)) frontier[runner].push(b);
				runner = idom[runner];
			}
		}
	}
	return { reachable, rpo, dom, idom, children, frontier };
}

export interface NaturalLoop {
	/** Loop header — target of every back edge, dominated by no other loop
	 *  block set here. */
	header: number;
	/** Blocks whose edge back to the header closes the loop. */
	latches: number[];
	/** All loop blocks (header included), ascending. */
	blocks: number[];
	/** Successor blocks OUTSIDE the loop (where the loop leaves). */
	exits: number[];
	/** Nesting depth: 1 = outermost loop. */
	depth: number;
}

export interface LoopAnalysis {
	loops: NaturalLoop[];
	/** Containing-loop depth per block (0 = not in any loop). */
	block_depth: number[];
}

/** Natural loops from back edges (t → h where h dominates t). Loops sharing
 *  a header merge; nesting depth comes from body containment. */
export function analyze_loops(cfg: FunctionCfg, dom: DominanceResult): LoopAnalysis {
	const latches_by_header = new Map<number, number[]>();
	for (const b of cfg.blocks) {
		if (!dom.reachable[b.id]) continue;
		for (const s of b.succs) {
			if (dom.dom[b.id].has(s)) {
				const list = latches_by_header.get(s) ?? [];
				list.push(b.id);
				latches_by_header.set(s, list);
			}
		}
	}
	const loops: NaturalLoop[] = [];
	for (const [header, latches] of latches_by_header) {
		const body = new Set<number>([header]);
		const stack: number[] = [];
		for (const l of latches) {
			body.add(l);
			if (l !== header) stack.push(l);
		}
		while (stack.length) {
			const b = stack.pop()!;
			for (const p of cfg.blocks[b].preds) {
				if (dom.reachable[p] && !body.has(p)) {
					body.add(p);
					stack.push(p);
				}
			}
		}
		const blocks = [...body].sort((a, b) => a - b);
		const exits = new Set<number>();
		for (const b of blocks) {
			for (const s of cfg.blocks[b].succs) if (!body.has(s)) exits.add(s);
		}
		loops.push({ header, latches, blocks, exits: [...exits].sort((a, b) => a - b), depth: 0 });
	}
	loops.sort((a, b) => a.blocks.length - b.blocks.length);
	for (let i = 0; i < loops.length; i++) {
		let depth = 1;
		for (let j = 0; j < loops.length; j++) {
			if (j === i || loops[j].blocks.length <= loops[i].blocks.length) continue;
			if (loops[i].blocks.every((b) => loops[j].blocks.includes(b))) depth++;
		}
		loops[i].depth = depth;
	}
	const block_depth: number[] = Array.from({ length: cfg.blocks.length }, () => 0);
	for (const l of loops)
		for (const b of l.blocks) block_depth[b] = Math.max(block_depth[b], l.depth);
	return { loops, block_depth };
}

/** One-call convenience for future consumers: CFG + all analyses. */
export function analyze_cfg(fn: FunctionCfg): {
	liveness: LivenessResult;
	dominance: DominanceResult;
	loops: LoopAnalysis;
} {
	const dominance = analyze_dominance(fn);
	return { liveness: analyze_liveness(fn), dominance, loops: analyze_loops(fn, dominance) };
}
