import fs from "node:fs";

import { expect, test } from "vite-plus/test";

import join from "../src/join";
import { get_library } from "../src/lib";
import {
	analyze_cfg,
	analyze_dominance,
	analyze_liveness,
	analyze_loops,
	reachable_blocks,
} from "../src/nir/analysis";
import { build_cfg, type FunctionCfg } from "../src/nir/cfg";
import { lower_function } from "../src/nir/from_ast";
import type FunctionNode from "../src/nodes/FunctionNode";
import parse from "../src/parse";

function compile_cfg(source: string, name: string): FunctionCfg {
	const parsed = parse(source);
	expect(parsed.errors).toEqual([]);
	const fn = parsed.root.statements.find(
		(s) => s.node_type === "func" && (s as FunctionNode).name === name,
	) as FunctionNode | undefined;
	expect(fn).toBeTruthy();
	return build_cfg(lower_function(fn!));
}

function names(set: Set<string>): string[] {
	return [...set].sort();
}

test("straight-line function is one unreachable-terminated block", () => {
	const cfg = compile_cfg(
		`
pub func straight = () {
    var int x = 1
    x = x + 2
}
`,
		"straight",
	);
	expect(cfg.entry).toBe(0);
	expect(cfg.blocks.length).toBe(1);
	expect(cfg.blocks[0].term.t).toBe("unreachable");
	expect(cfg.blocks[0].succs).toEqual([]);
	expect(cfg.blocks[0].stmts.map((s) => s.op)).toEqual(["declare", "assign"]);
	expect(cfg.names).toContain("x");
	const { liveness } = analyze_cfg(cfg);
	expect(names(liveness.live_in[0])).toEqual([]);
	expect(names(liveness.live_out[0])).toEqual([]);
});

test("if/else diamond: branch/join shape, dominance and liveness", () => {
	const cfg = compile_cfg(
		`
pub func diamond = (int c, out int) {
    var int v = 0
    if c > 0 {
        v = 1
    } else {
        v = 2
    }
    return v
}
`,
		"diamond",
	);
	expect(cfg.blocks.length).toBe(4);
	const [entry, then_b, else_b, join] = cfg.blocks;
	expect(entry.term.t).toBe("branch");
	expect(entry.succs).toEqual([then_b.id, else_b.id]);
	expect(join.preds).toEqual([then_b.id, else_b.id]);
	expect((join.term as any).t).toBe("return");

	const dom = analyze_dominance(cfg);
	expect(dom.idom[join.id]).toBe(entry.id);
	expect([...dom.dom[join.id]].sort((a, b) => a - b)).toEqual([entry.id, join.id]);
	// The branches don't strictly dominate the join, so it sits in THEIR
	// frontiers (entry dominates everything, hence an empty frontier).
	expect(dom.frontier[then_b.id]).toContain(join.id);
	expect(dom.frontier[else_b.id]).toContain(join.id);
	expect(dom.frontier[entry.id]).toEqual([]);
	expect(dom.rpo[0]).toBe(entry.id);

	const { liveness } = analyze_cfg(cfg);
	// `c` is read by the branch terminator; `v` is defined before it.
	expect(names(liveness.live_in[entry.id])).toEqual(["c"]);
	// Each branch defines `v` and the join reads it.
	expect(names(liveness.live_in[then_b.id])).toEqual([]);
	expect(names(liveness.live_out[then_b.id])).toEqual(["v"]);
	expect(names(liveness.live_in[join.id])).toEqual(["v"]);
});

test("while loop forms a natural loop; header carries its condition", () => {
	const cfg = compile_cfg(
		`
pub func loopy = (int n, out int) {
    var int sum = 0
    var int i = 0
    while i < n {
        sum = sum + i
        i = i + 1
    }
    return sum
}
`,
		"loopy",
	);
	expect(cfg.blocks.length).toBe(4);
	const header = cfg.blocks[1];
	expect(header.stmts).toEqual([]);
	const { liveness, dominance, loops } = analyze_cfg(cfg);
	expect(loops.loops.length).toBe(1);
	const loop = loops.loops[0];
	expect(loop.header).toBe(header.id);
	expect(loop.latches).toEqual([2]);
	expect(loop.blocks).toEqual([1, 2]);
	expect(loop.exits).toEqual([3]);
	expect(loop.depth).toBe(1);
	expect(loops.block_depth[2]).toBe(1);
	expect(loops.block_depth[3]).toBe(0);
	// Back edge: the header dominates its latch and appears in its own frontier.
	expect(dominance.idom[2]).toBe(header.id);
	expect(dominance.frontier[header.id]).toContain(header.id);
	// Loop-carried values are live entering the header.
	expect(names(liveness.live_in[header.id])).toEqual(["i", "n", "sum"]);
});

test("for loop: continue targets the update block, break the exit block", () => {
	const cfg = compile_cfg(
		`
pub func skip_some = (out int) {
    var int t = 0
    for i of 0..10 {
        if i == 3 {
            continue
        }
        if i == 7 {
            break
        }
        t = t + i
    }
    return t
}
`,
		"skip_some",
	);
	const { liveness, loops } = analyze_cfg(cfg);
	const header = cfg.blocks.find((b) => b.stmts.some((s) => s.op === "loop_item"));
	expect(header).toBeTruthy();
	const header_id = header!.id;
	expect(loops.loops.length).toBe(1);
	expect(loops.loops[0].header).toBe(header_id);
	const exit_id = (header!.term as any).if_false as number;
	// The update block: gotos the header, holds no statements (unlike the
	// entry block, which also falls into the header but carries setup).
	const update = cfg.blocks.find(
		(b) =>
			b.id !== header_id &&
			b.term.t === "goto" &&
			(b.term as any).target === header_id &&
			b.stmts.length === 0,
	);
	expect(update).toBeTruthy();
	expect(update!.stmts).toEqual([]);
	// The continue block jumps to the update block.
	const continue_block = cfg.blocks.find(
		(b) => b.term.t === "goto" && (b.term as any).target === update!.id,
	);
	expect(continue_block).toBeTruthy();
	// The break block jumps straight to the loop exit.
	const break_block = cfg.blocks.find((b) => b.succs.length === 1 && b.succs[0] === exit_id);
	expect(break_block).toBeTruthy();
	// The loop item is defined in the header (not live-IN of it); `t` is.
	expect(liveness.live_in[header_id].has("i")).toBe(false);
	expect(liveness.live_in[header_id].has("t")).toBe(true);
	expect(liveness.live_out[update!.id].has("t")).toBe(true);
});

test("returns in both branches leave the join unreachable", () => {
	const cfg = compile_cfg(
		`
pub func early = (int c, out int) {
    if c > 0 {
        return 1
    } else {
        return 2
    }
}
`,
		"early",
	);
	expect(cfg.blocks.length).toBe(4);
	const join = cfg.blocks[3];
	expect(join.preds).toEqual([]);
	expect(join.term.t).toBe("unreachable");
	const reachable = reachable_blocks(cfg);
	expect(reachable[3]).toBe(false);
	const dom = analyze_dominance(cfg);
	expect(dom.idom[3]).toBe(-1);
	expect(dom.rpo.length).toBe(3);
	const { liveness } = analyze_cfg(cfg);
	expect(names(liveness.live_in[0])).toEqual(["c"]);
});

test("match lowers to a sequential condition chain with a shared join", () => {
	const cfg = compile_cfg(
		`
pub func sw = (int c, out int) {
    match c {
        case 1 { return 1 }
        case 2 { return 2 }
        else { return 3 }
    }
}
`,
		"sw",
	);
	// entry(scrutinee + branch), arm0, arm1, join, otherwise, chain.
	expect(cfg.blocks.length).toBe(6);
	const entry = cfg.blocks[0];
	expect(entry.term.t).toBe("branch");
	const arm0 = cfg.blocks[(entry.term as any).if_true as number];
	const chain = cfg.blocks[(entry.term as any).if_false as number];
	expect(chain.term.t).toBe("branch");
	const arm1 = cfg.blocks[(chain.term as any).if_true as number];
	const otherwise = cfg.blocks[(chain.term as any).if_false as number];
	expect(arm0.term.t).toBe("return");
	expect(arm1.term.t).toBe("return");
	expect(otherwise.term.t).toBe("return");
	// Both arms returned, so the shared join has no predecessors left.
	const join = cfg.blocks.find((b) => b.term.t === "unreachable" && b.preds.length === 0);
	expect(join).toBeTruthy();
	expect(analyze_loops(cfg, analyze_dominance(cfg)).loops.length).toBe(0);
	// The scrutinee is read once, in the entry block.
	expect(names(analyze_liveness(cfg).live_in[0])).toEqual(["c"]);
});

test("ref call arguments are may-defs of the passed variable", () => {
	const cfg = compile_cfg(
		`
func bump = (ref int x) {
    x = x + 1
}

pub func caller = (out int) {
    var int v = 1
    bump(ref v)
    return v
}
`,
		"caller",
	);
	expect(cfg.blocks.length).toBe(1);
	const call = cfg.blocks[0].stmts[1];
	expect(call.op).toBe("eval");
	expect(call.defs).toContain("v");
	expect(call.barrier).toBe(false);
	// The callee's ref param assignment defs the param name too.
	const bump_parsed = parse(`
func bump = (ref int x) {
    x = x + 1
}
`);
	expect(bump_parsed.errors).toEqual([]);
	const bump_cfg = build_cfg(lower_function(bump_parsed.root.statements[0] as FunctionNode));
	expect(bump_cfg.names).toEqual(["x"]);
	expect(bump_cfg.blocks[0].stmts[0].defs).toContain("x");
});

test("raw asm blocks are liveness barriers", () => {
	const cfg = compile_cfg(
		`
func barred = (out int) {
    var int x = 1
    if x > 0 {
        \`\`\`
        #arch: c
        x = 2;
        \`\`\`
    } else {
        x = 3
    }
    return 0
}
`,
		"barred",
	);
	const then_b = cfg.blocks[1];
	const raw = then_b.stmts.find((s) => s.op === "raw");
	expect(raw).toBeTruthy();
	expect(raw!.barrier).toBe(true);
	// `x` is never read after its def, yet the barrier keeps it live into
	// the raw block (the asm may read it).
	const { liveness } = analyze_cfg(cfg);
	expect(liveness.live_in[then_b.id].has("x")).toBe(true);
	// The plain else-branch assignment is NOT a barrier: x is dead there.
	const else_b = cfg.blocks[2];
	expect(liveness.live_in[else_b.id].has("x")).toBe(false);
});

test("nested functions become separate CFGs outside the enclosing flow", () => {
	const cfg = compile_cfg(
		`
pub func outer = () {
    var int a = 1
    func inner = (int p, out int) {
        var int q = p + 1
        return q
    }
    a = a + 3
}
`,
		"outer",
	);
	expect(cfg.nested.length).toBe(1);
	const inner = cfg.nested[0];
	expect(inner.name).toBe("inner");
	expect(inner.names).toEqual(["p", "q"]);
	expect(inner.blocks.length).toBeGreaterThanOrEqual(1);
	// The nested body's declarations do not join the parent's universe, and
	// the parent's flow never grew blocks for the nested body.
	expect(cfg.names).toEqual(["a"]);
	expect(cfg.blocks.length).toBe(1);
});

test("benchmark corpus: cfg, liveness, dominance and loops stay consistent", () => {
	const bench_dir = "bench/nomen";
	let checked = 0;
	const check_cfg = (cfg: FunctionCfg): void => {
		const { liveness, dominance, loops } = analyze_cfg(cfg);
		// Entry is block 0 and always reachable.
		expect(cfg.entry).toBe(0);
		expect(dominance.reachable[0]).toBe(true);
		for (const b of cfg.blocks) {
			if (!dominance.reachable[b.id] || b.id === cfg.entry) continue;
			// Every reachable non-entry block has a valid immediate dominator
			// whose dominators are a strict subset of its own.
			const id = dominance.idom[b.id];
			expect(id).toBeGreaterThanOrEqual(0);
			for (const d of dominance.dom[id]) expect(dominance.dom[b.id].has(d)).toBe(true);
			expect(dominance.dom[b.id].has(b.id)).toBe(true);
		}
		// Anything live at function entry comes from the name universe.
		for (const v of liveness.live_in[0]) expect(cfg.names).toContain(v);
		for (const loop of loops.loops) {
			expect(dominance.reachable[loop.header]).toBe(true);
			expect(loop.blocks).toContain(loop.header);
			for (const latch of loop.latches) expect(loop.blocks).toContain(latch);
		}
		checked++;
		for (const nested of cfg.nested) check_cfg(nested);
	};
	for (const file of fs.readdirSync(bench_dir)) {
		if (!file.endsWith(".nm")) continue;
		const path = `${bench_dir}/${file}`;
		const source = join(path, "core");
		const parsed = parse(source, get_library("core"));
		const walk = (n: any): any[] => {
			if (!n || typeof n !== "object") return [];
			if (Array.isArray(n)) return n.flatMap(walk);
			const found = n.node_type === "func" ? [n as FunctionNode] : [];
			return found.concat(
				Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk((n as any)[k]))),
			);
		};
		for (const fn of walk(parsed.root)) {
			const lowered = lower_function(fn);
			expect([...lowered.unknown_kinds], `${file}:${fn.name}`).toEqual([]);
			check_cfg(build_cfg(lowered));
		}
	}
	expect(checked).toBeGreaterThan(0);
});

test("swap assignments count the replacement's reads and the rhs source as a def", () => {
	// `a = b swap Box(c)`: b's old value moves into a (read) AND the
	// replacement is stored into b (may-def); the replacement's argument
	// `c` joins the reads — so `c` (a param) is live into the block.
	const cfg = compile_cfg(
		`
class Box {
    var int value
}
pub func swapper = (int c, out int) {
    var Box a = Box(0)
    var Box b = Box(1)
    a = b swap Box(c)
    return a.value
}
`,
		"swapper",
	);
	const assign = cfg.blocks[0].stmts.find((s) => s.op === "assign");
	expect(assign).toBeTruthy();
	expect(assign!.reads).toContain("b");
	expect(assign!.reads).toContain("c");
	expect(assign!.defs).toContain("a");
	expect(assign!.defs).toContain("b");
	expect(assign!.barrier).toBe(false);
	const { liveness } = analyze_cfg(cfg);
	expect(liveness.live_in[0]).toContain("c");
});

test("value-position flow folds arm reads into the flat statement's facts", () => {
	const cfg = compile_cfg(
		`
pub func flow_facts = (int q, out int) {
    var int k = match 1 {
        case 1 -> q
        else -> 0
    }
    return k
}
`,
		"flow_facts",
	);
	const decl = cfg.blocks[0].stmts.find((s) => s.op === "declare");
	expect(decl?.reads).toContain("q");
	const { liveness } = analyze_cfg(cfg);
	// `q` is read by the (folded) flow value, so it is live into entry.
	expect(names(liveness.live_in[0])).toContain("q");
});

test("value-position spawn folds its call arguments' reads into the flat statement", () => {
	const cfg = compile_cfg(
		`
func work = (uint64 arg) {}
pub func spawn_facts = (uint64 n) {
    var t = spawn work(n)
}
`,
		"spawn_facts",
	);
	const decl = cfg.blocks[0].stmts.find((s) => s.op === "declare");
	expect(decl?.reads).toContain("n");
	const { liveness } = analyze_cfg(cfg);
	expect(names(liveness.live_in[0])).toContain("n");
});
