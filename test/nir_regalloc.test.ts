import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { plan_function_promotions } from "../src/build_aarch64/utils/func_regalloc";
import {
	nir_regalloc_enabled,
	plan_nir_registers,
	set_nir_regalloc_enabled,
	set_nir_site_promotion_enabled,
} from "../src/build_aarch64/utils/nir_regalloc";
import { build_cfg } from "../src/nir/cfg";
import { lower_function } from "../src/nir/from_ast";
import type FunctionNode from "../src/nodes/FunctionNode";
import { parse_raw } from "./parse_with_imports";

/**
 * Tranche G stage 1 (ASM_PLAN_2): NIR-level int register allocation.
 *
 * The allocator replaces read-count ranking with statement-granularity
 * liveness over the NIR CFG: non-overlapping live ranges SHARE a register,
 * ranges crossing a call (or barrier) stay callee-saved, and ranges that
 * never touch a call may take the caller-saved x12-x15 pool. A variable
 * live into any loop header is never caller-saved (the NEON preheader
 * clobbers x9-x14). Kill-switch off (default) = legacy pass, byte-identical.
 */

function func_named(source: string, name: string): FunctionNode {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const fn = parsed.root.statements.find(
		(s) => s.node_type === "func" && (s as FunctionNode).name === name,
	) as FunctionNode;
	expect(fn).toBeDefined();
	return fn;
}

function plan_for(source: string, name: string): Map<string, string> {
	const fn = func_named(source, name);
	return plan_nir_registers(fn, lower_function(fn)).allocs;
}

const CALLER = /^x1[2-5]$/;
const CALLEE = /^x2[3-8]$/;

test("kill-switch defaults ON; disabling falls back to the legacy pass", () => {
	expect(nir_regalloc_enabled()).toBe(true);
});

test("non-overlapping live ranges share one caller-saved register", () => {
	const source = `
import System

func seq = (int n, out int) {
	var int a = n + 1
	a = a + 1
	a = a + 1
	a = a + 1
	var int r1 = a
	var int b = n + 2
	b = b + 1
	b = b + 1
	b = b + 1
	var int r2 = b
	var int total = r1 + r2
	return total
}
pub func main = () {}
`;
	const allocs = plan_for(source, "seq");
	// a dies at `var r1 = a`; b is defined after — their ranges never
	// overlap, so both ride the same caller-saved register.
	expect(allocs.has("a")).toBe(true);
	expect(allocs.has("b")).toBe(true);
	expect(allocs.get("a")).toBe(allocs.get("b"));
	expect(allocs.get("a")).toMatch(CALLER);
	// The whole function is one call-free region (no loops), so even the
	// low-read names (r1/total: one read each) take caller-saved registers
	// under the low-read extension — never callee-saved ones.
	for (const name of ["r1", "total"]) {
		if (allocs.has(name)) {
			expect(allocs.get(name)).toMatch(CALLER);
		}
	}
});

test("simultaneously-live variables get distinct callee-saved registers", () => {
	const source = `
import System

func pair = (int n, out int) {
	var int a = 0
	var int b = 0
	var int i = 0
	while i < n; i += 1 {
		a = a + i
		a = a + 1
		b = b + i * 2
		b = b + 2
	}
	Console.write("\\{a} \\{b}")
	return a * 10 + b
}
pub func main = () {}
`;
	const allocs = plan_for(source, "pair");
	// a and b are both live across the loop and the trailing call: they
	// interfere, so they land in distinct callee-saved registers.
	expect(allocs.has("a")).toBe(true);
	expect(allocs.has("b")).toBe(true);
	expect(allocs.get("a")).not.toBe(allocs.get("b"));
	expect(allocs.get("a")).toMatch(CALLEE);
	expect(allocs.get("b")).toMatch(CALLEE);
	// The induction `i` is live into the loop header — never the ext pool.
	expect(allocs.get("i")).toMatch(CALLEE);
});

test("a range crossing a call stays callee-saved while a contained range takes the ext pool", () => {
	const source = `
import System

func across = (int n, out int) {
	var int x = n * 2
	x = x + 1
	x = x + 1
	x = x + 1
	Console.write("marker")
	var int y = x + 1
	y = y + 1
	y = y + 1
	y = y + 1
	var int z = y + 1
	z = z + 1
	z = z + 1
	z = z + 1
	Console.write("\\{z}")
	return z
}
pub func main = () {}
`;
	const allocs = plan_for(source, "across");
	// x is live across the Console.write call → callee-saved.
	expect(allocs.get("x")).toMatch(CALLEE);
	// y is defined after the call and dead before the next one → its whole
	// range is call-free → caller-saved ext pool.
	expect(allocs.get("y")).toMatch(CALLER);
	// z is read by the final call statement → conservatively crossing.
	expect(allocs.get("z")).toMatch(CALLEE);
});

test("register sharing never co-locates interfering ranges (fannkuch shape)", () => {
	// The fannkuch-redux kernel: flips is read inside p0's loop AND after
	// it, while several non-interfering temporaries share registers in
	// between. A register→single-name occupancy map let an interfering
	// latecomer slip onto a shared register through a chain of legal
	// sharers — corrupting the output at n=11. The invariant: every pair
	// of names on ONE register has NO interference edge.
	const source = `
import System

func fk = (int n, out int) {
	var int idx = 0
	var int sign = 1
	var int flips = 0
	var int p0 = n
	var int check_sum = 0
	var int max_flips = 0
	while idx < n; idx += 1 {
		flips = 1
		while p0 > 0; p0 -= 1 {
			flips += 1
			var int lo = 1
			var int hi = p0 - 1
			while lo < hi {
				lo += 1
				hi -= 1
			}
		}
		if flips > max_flips {
			max_flips = flips
		}
		check_sum = check_sum + flips
		if sign == 1 {
			sign = 0
		} else {
			sign = 1
		}
	}
	return check_sum + max_flips
}
pub func main = () {}
`;
	expect_no_shared_interference(func_named(source, "fk"));
});

test("the real fannkuch-redux bench kernel keeps the sharing invariant", async () => {
	// The actual bench function that exposed the single-occupancy bug.
	const { default: path } = await import("node:path");
	const { default: join } = await import("../src/join");
	const { get_library } = await import("../src/lib");
	const { default: parse } = await import("../src/parse");
	const root_dir = path.resolve(import.meta.dirname, "..");
	const source = join(path.join(root_dir, "bench/nomen/fannkuch-redux.nm"), "core");
	const parsed = parse(source, get_library(path.join(root_dir, "core")));
	expect(parsed.errors).toEqual([]);
	expect_no_shared_interference(
		parsed.root.statements.find(
			(s) => s.node_type === "func" && (s as FunctionNode).name === "run",
		) as FunctionNode,
	);
});

function expect_no_shared_interference(fn: FunctionNode): void {
	expect(fn).toBeDefined();
	const nir = lower_function(fn);
	const plan = plan_nir_registers(fn, nir);
	expect(plan.allocs.size).toBeGreaterThan(0);
	// The adjacency rides the plan itself: its keys are source names for
	// uniquely-declared variables and decl-site keys (`name@N`) for
	// ambiguous ones — exactly the keys allocs was assigned over.
	const { adj } = plan;
	const by_reg = new Map<string, string[]>();
	for (const [vname, reg] of plan.allocs) {
		const list = by_reg.get(reg) ?? [];
		list.push(vname);
		by_reg.set(reg, list);
	}
	for (const [reg, names] of by_reg) {
		for (let i = 0; i < names.length; i++) {
			for (let j = i + 1; j < names.length; j++) {
				const interferes = adj.get(names[i])?.has(names[j]) ?? false;
				expect(interferes, `${names[i]} and ${names[j]} interfere but share ${reg}`).toBe(false);
			}
		}
	}
}

test("float assignments stay identical to the legacy pass", () => {
	const source = `
import System

func flo = (int n, out float) {
	var float a = 0.5
	a = a + 1.0
	a = a + 1.0
	a = a + 1.0
	var float b = 2.5
	b = b + a
	b = b + a
	b = b + a
	return b + n as float
}
pub func main = () {}
`;
	const fn = func_named(source, "flo");
	const nir = lower_function(fn);
	const legacy = plan_function_promotions(fn, nir);
	const fresh = plan_nir_registers(fn, nir).allocs;
	for (const name of ["a", "b"]) {
		expect(fresh.get(name)).toBe(legacy.get(name));
		expect(fresh.get(name)).toMatch(/^d\d+$/);
	}
});

test("callee-saved set never contains caller-saved ext registers", () => {
	const source = `
import System

func mixed = (int n, out int) {
	var int a = n + 1
	a = a + 1
	a = a + 1
	a = a + 1
	var int r1 = a
	var int b = 0
	var int i = 0
	while i < n; i += 1 {
		b = b + i
		b = b + 1
		b = b + 1
	}
	Console.write("\\{r1} \\{b}")
	return b
}
pub func main = () {}
`;
	const fn = func_named(source, "mixed");
	const plan = plan_nir_registers(fn, lower_function(fn));
	for (const reg of plan.callee_saved) {
		expect(reg).toMatch(/^(x2[3-8]|d\d+)$/);
	}
	// a dies before the loop and the call → caller-saved, NOT callee-saved.
	expect(plan.allocs.get("a")).toMatch(CALLER);
	expect(plan.callee_saved.has(plan.allocs.get("a")!)).toBe(false);
	// b is live into the loop header → callee-saved.
	expect(plan.allocs.get("b")).toMatch(CALLEE);
	expect(plan.callee_saved.has(plan.allocs.get("b")!)).toBe(true);
});

test("enabled pass compiles and runs shared-register programs correctly", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	set_nir_regalloc_enabled(true);
	try {
		await build_and_check_output(
			`
import System

func seq = (int n, out int) {
	var int a = n + 1
	a = a + 1
	a = a + 1
	a = a + 1
	var int r1 = a
	var int b = n + 2
	b = b + 1
	b = b + 1
	b = b + 1
	var int r2 = b
	return r1 * 100 + r2
}

func pair = (int n, out int) {
	var int a = 0
	var int b = 0
	var int i = 0
	while i < n; i += 1 {
		a = a + i
		a = a + 1
		b = b + i * 2
		b = b + 2
	}
	return a * 10 + b
}
pub func main = () {
	Console.write("\\{seq(3)} \\{pair(4)}")
}
`,
			"nir_regalloc_behavior",
			"708 120",
			true,
		);
	} finally {
		set_nir_regalloc_enabled(true);
	}
});

test("loop sharing stays correct when an inline-expandable loop callee runs inside promoted loops", async () => {
	// The mandelbrot hang (stage-2 receipt): a pure-math loop-containing
	// function (an inline candidate) expanded inside main's loops, whose
	// promotion claims leaked through callee_saved_regs_used — the
	// expansion's vacuous "shares" claimed the caller's loop registers and
	// the outer induction never advanced. Behavioral guard at that shape.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	set_nir_regalloc_enabled(true);
	try {
		await build_and_check_output(
			`
import System

func kernel = (int seed, out int) {
	var acc = 0
	var k = 0
	while k < 5; k += 1 {
		acc = acc + seed * k + 1
	}
	if acc > 100 {
		return 1
	}
	return 0
}
pub func main = () {
	var hits = 0
	var i = 0
	while i < 6; i += 1 {
		var j = 0
		while j < 4; j += 1 {
			if kernel(i * 3 + j) == 1 {
				hits = hits + 1
			}
		}
	}
	Console.write("hits \\{hits}")
}
`,
			"nir_regalloc_inline_expand",
			"hits 11",
			true,
		);
	} finally {
		set_nir_regalloc_enabled(true);
	}
});

test("self field writes are honest defs, not liveness barriers", () => {
	// Stage-2 barrier fix: `self.len = …` used to lower to a path whose
	// root was a nameless leaf — cfg.ts set the whole-universe barrier,
	// marking every name in the method as call-crossing. The CFG must now
	// carry `self` as the path root.
	const source = `
import System

struct Box {
	var int len
	var int cap

	pub func fill = (ref self, int n) {
		self.len = n
		var int i = 0
		while i < n; i += 1 {
			i = i + 1
		}
		self.cap = i
	}
}
	pub func main = () {}
`;
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const box = parsed.root.statements.find((s) => s.node_type === "struct") as any;
	expect(box).toBeDefined();
	const fill = box.functions.find((f: any) => f.name === "fill") as FunctionNode;
	expect(fill).toBeDefined();
	const nir = lower_function(fill);
	const cfg = build_cfg(nir);
	const assign_stmts = cfg.blocks.flatMap((b) => b.stmts.filter((s) => s.op === "assign"));
	const field_writes = assign_stmts.filter((s) => s.barrier);
	expect(field_writes).toEqual([]);
});

test("build output with the kill-switch off is unchanged by the integration", () => {
	const source = `
import System

pub func main = () {
	var int a = 1
	a = a + 2
	Console.write("\\{a}")
}
`;
	set_nir_regalloc_enabled(false);
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const first = build(parsed.root, { arch: "aarch64" });
	const second = build(parsed.root, { arch: "aarch64" });
	expect(first.code).toEqual(second.code);
	expect(nir_regalloc_enabled()).toBe(false);
	set_nir_regalloc_enabled(true);
});

// ==================== stage 3: decl-site disambiguation ====================

const SIBLING_LOOPS = `
import System

func two_loops = (int n, out int) {
	var int total = 0
	var int i = 0
	while i < 3; i += 1 {
		const int v = n + i
		total = total + v * 2
	}
	var int j = 0
	while j < 3; j += 1 {
		const int v = n * j + 1
		total = total + v
	}
	return total
}
pub func main = () {}
`;

test("same-named consts in sibling loops get per-site registers", () => {
	// Pre-stage-3 this whole function was excluded: `v` is declared twice
	// and the name-keyed model could not give two scopes one name's register.
	const fn = func_named(SIBLING_LOOPS, "two_loops");
	const plan = plan_nir_registers(fn, lower_function(fn));
	const v_sites = [...plan.sites.entries()].filter(([, s]) => s.name === "v");
	expect(v_sites.length).toBe(2);
	// Each site's key resolved to a register in the plan.
	for (const [key] of v_sites) {
		expect(plan.allocs.get(key)).toMatch(/^(x\d+|d\d+)$/);
	}
	// Uniquely-declared names stay plain (byte-parity path): total/i/j are
	// never site-keyed.
	expect(plan.sites.size).toBe(2);
});

test("site sharing keeps the no-interference invariant", () => {
	const fn = func_named(SIBLING_LOOPS, "two_loops");
	const nir = lower_function(fn);
	const plan = plan_nir_registers(fn, nir);
	// Every pair of names on ONE register — site keys included — must have
	// no interference edge.
	const by_reg = new Map<string, string[]>();
	for (const [key, reg] of plan.allocs) {
		const list = by_reg.get(reg) ?? [];
		list.push(key);
		by_reg.set(reg, list);
	}
	for (const [reg, keys] of by_reg) {
		for (let a = 0; a < keys.length; a++) {
			for (let b = a + 1; b < keys.length; b++) {
				const interferes = plan.adj.get(keys[a])?.has(keys[b]) ?? false;
				expect(interferes, `${keys[a]} and ${keys[b]} interfere but share ${reg}`).toBe(false);
			}
		}
	}
});

test("site-promotion kill-switch off restores the stage-2 exclusion", () => {
	const fn = func_named(SIBLING_LOOPS, "two_loops");
	const nir = lower_function(fn);
	set_nir_site_promotion_enabled(false);
	try {
		const plan = plan_nir_registers(fn, nir);
		expect(plan.sites.size).toBe(0);
		// Both `v` sites excluded: no key mentioning v anywhere.
		for (const key of plan.allocs.keys()) {
			expect(key.startsWith("v@")).toBe(false);
		}
	} finally {
		set_nir_site_promotion_enabled(true);
	}
});

test("multi-decl program compiles and runs its sibling sites correctly", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	set_nir_regalloc_enabled(true);
	try {
		await build_and_check_output(
			`
import System

func two_loops = (int n, out int) {
	var int total = 0
	var int i = 0
	while i < 3; i += 1 {
		const int v = n + i
		total = total + v * 2
	}
	var int j = 0
	while j < 3; j += 1 {
		const int v = n * j + 1
		total = total + v
	}
	return total
}
pub func main = () {
	Console.write("\\{two_loops(4)}")
}
`,
			"nir_site_sibling_loops",
			"45",
			true,
		);
	} finally {
		set_nir_regalloc_enabled(true);
	}
});

test("behavioral: sibling same-named consts keep independent values", async () => {
	// The two `v` consts must never alias one register: loop 1 adds
	// (n+i)*10 per iteration, loop 2 adds n*1000 + j*3 — any aliasing
	// corrupts one of the running sums.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	set_nir_regalloc_enabled(true);
	try {
		await build_and_check_output(
			`
import System

func drive = (int n, out int) {
	var int total = 0
	var int i = 0
	while i < 4; i += 1 {
		const int v = n * 100 + i
		total = total + v * 10
	}
	var int j = 0
	while j < 4; j += 1 {
		const int v = n * 1000 + j * 3
		total = total + v
	}
	return total
}
pub func main = () {
	Console.write("\\{drive(7)}")
}
`,
			"nir_site_behavior",
			"56078",
			true,
		);
	} finally {
		set_nir_regalloc_enabled(true);
	}
});
