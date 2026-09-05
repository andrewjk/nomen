import fs from "node:fs";

import { expect, test } from "vite-plus/test";

import { plan_function_promotions } from "../src/build_aarch64/utils/func_regalloc";
import join from "../src/join";
import { get_library } from "../src/lib";
import { is_identifier_like, lower_function } from "../src/nir/from_ast";
import { analyze_function, analyze_traffic } from "../src/nir/traffic";
import AssignmentNode from "../src/nodes/AssignmentNode";
import type BaseNode from "../src/nodes/BaseNode";
import FunctionNode from "../src/nodes/FunctionNode";
import OperationNode from "../src/nodes/OperationNode";
import Type from "../src/nodes/Type";
import ValueNode from "../src/nodes/ValueNode";
import WhileLoopNode from "../src/nodes/WhileLoopNode";
import parse from "../src/parse";
import { parse_raw } from "./parse_with_imports";

function ident(name: string): ValueNode {
	return new ValueNode(0, name);
}

function assign(left: string, right: BaseNode): AssignmentNode {
	return new AssignmentNode(0, ident(left), right);
}

function add(left: BaseNode, right: BaseNode): OperationNode {
	return new OperationNode(0, "+", left, right);
}

test("weighted reads double-count loop bodies and see if branches", () => {
	// var int h = 0
	// h = h + h
	// if c { while w { h = h + h } }
	const decl: any = {
		node_type: "declare",
		name: "h",
		type: new Type("int"),
		value: ident("0"),
	};
	const iff: any = {
		node_type: "if",
		condition: ident("c"),
		if_branch: {
			node_type: "branch",
			statements: [new WhileLoopNode(0, ident("w"), [assign("h", add(ident("h"), ident("h")))])],
		},
		else_branch: undefined,
	};

	const report = analyze_function({
		params: [],
		statements: [decl as BaseNode, assign("h", add(ident("h"), ident("h"))), iff as BaseNode],
	});

	// Each `h = h + h` counts its LHS target + two RHS leaves (legacy
	// counting). Three reads at depth 0, three per loop pass at depth 1.
	expect(report.variables.get("h")).toEqual({
		reads: 6,
		weighted_reads: 3 * 8 + 3,
		address_taken: false,
	});
	expect(report.variables.get("c")?.reads).toBe(1);
	expect(report.variables.get("w")?.weighted_reads).toBe(8);
});

test("address-take is reported for access receivers even inside branches", () => {
	// p.field = 1  →  p's address escapes via the access target
	const acc: any = { node_type: "access", target: ident("p"), access: undefined };
	const asgn = new AssignmentNode(0, acc as any, ident("1"));
	const decl: any = {
		node_type: "declare",
		name: "p",
		type: new Type("Point"),
		value: ident("MyPoint()"),
	};

	const report = analyze_function({ params: [], statements: [decl as BaseNode, asgn] });

	expect(report.variables.get("p")?.address_taken).toBe(true);
});

test("method-call arguments count as reads and ref indices feed exclusions", () => {
	const push_call: any = {
		node_type: "access",
		target: ident("xs"),
		access: {
			node_type: "access_func",
			name: "push",
			params: [ident("t")],
			ref_param_indices: [0],
		},
	};

	const report = analyze_function({ params: [], statements: [push_call as BaseNode] });
	expect(report.variables.get("t")?.reads).toBe(1);
	expect(report.variables.get("xs")?.address_taken).toBe(true);
	expect(report.ref_arg_names.has("t")).toBe(true);
});

test("equal-read candidates break ties by loop nesting (contended pool)", () => {
	const input = `
pub func main = () {
    var int s = 1
    s = s + s + s + s + s
    var int q = 2
    for it of [1, 2] {
        q = q + q + q + q + q
    }
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const main = parsed.root.statements.find((s) => s.node_type === "func") as FunctionNode;
	expect(main?.name).toBe("main");

	const allocs = plan_function_promotions(main);
	// Both candidates have SIX raw reads; declaration order alone would put s
	// first. The loop-hot q takes the prime register instead while both stay
	// promoted (two-slot pool usage).
	expect(allocs.get("q")).toBe("x23");
	expect(allocs.get("s")).toBe("x24");
});

test("if-branch reads now qualify a variable that top-level reads alone miss", () => {
	const input = `
pub func hidden = () {
    var int t = 0
    t = t + 1
    var int u = 9
    if u > 0 {
        u = u + 1
        t = t + 1
        t = t + 1
        t = t + 1
    }
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const fn = parsed.root.statements.find((s) => s.node_type === "func") as FunctionNode;

	const allocs = plan_function_promotions(fn);
	// Two bare-statement reads (target + operand) sit under MIN_READS; the
	// six in-branch reads were invisible to the old per-statement scan.
	// Full coverage promotes t.
	expect(allocs.has("t")).toBe(true);
});

test("NIR lowering covers the exotic statement corpus without unknown kinds", () => {
	const input = `
import System
struct MyPoint {
    var int x
    var int y
}

enum MyShape {
    case circle(float radius)
    case unit
}

pub func nir_worker_ir = (int n) {}

pub func nir_demo_ir = (out float) {
    var int count = 0
    count = count + 3
    var [a, b] = [11, "hello"]
    a = a + 1
    const mid = count / 2
    match 7 {
        case 7 -> Console.write("seven")
        else -> Console.write("other")
    }
    match mid {
        case 3 {
            Console.write("three")
        }
        else {}
    }
    switch {
        case count > 100 -> Console.write("big")
        else -> Console.write("small")
    }
    var MyShape s = MyShape.circle(1.5)
    for it of [1, 2, 3] {
        Console.write("\\{it}")
    }
    for i of 0..10 {
        Console.write("\\{i}")
    }
    const point = [x = 4, y = 5]
    Console.write("\\{point.x}")
    async(timeout: 50) {
        spawn nir_worker_ir(1)
        spawn nir_worker_ir(2)
    }
    return point.y as float
}
`;
	const parsed = parse_raw(input);
	for (const err of parsed.errors)
		throw new Error(`parse error @${err.line}:${err.column}: ${err.message}`);
	const fns = parsed.root.statements.filter((s) => s.node_type === "func") as FunctionNode[];
	const lowered = fns.map((f) => lower_function(f));
	for (const fn of lowered) {
		expect([...fn.unknown_kinds]).toEqual([]);
	}
	const demo = lowered.find((f) => f.name === "nir_demo_ir");
	expect(demo).toBeTruthy();
	const kinds = new Set(demo!.body.map((s) => s.kind));
	const expected_kinds: readonly (
		| "declare"
		| "assign"
		| "eval"
		| "switch_match"
		| "for"
		| "async_block"
		| "return"
	)[] = ["declare", "assign", "eval", "switch_match", "for", "async_block", "return"];
	for (const k of expected_kinds) {
		expect(kinds.has(k)).toBe(true);
	}
});

test("benchmark corpus lowers fully — no unknown kinds anywhere", () => {
	const bench_dir = "bench/nomen";
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
			const nir = lower_function(fn);
			expect([...nir.unknown_kinds], `${file}:${fn.name}`).toEqual([]);
			analyze_traffic(nir);
		}
	}
});

test("identifier classification mirrors historical scan rules", () => {
	for (const ok of ["x", "_t", "ABC", "x1"]) expect(is_identifier_like(ok)).toBe(true);
	for (const bad of ['"str"', "'c'", "42", "-7", "2.5", "", "true", "false", "null", "self", "as"])
		expect(is_identifier_like(bad)).toBe(false);
});

test("assignment and declaration swaps ride the IR; traffic keeps historical parity", () => {
	const input = `
class Box {
    var int value
}
pub func swapper = (int q, out int) {
    var Box a = Box(0)
    var Box b = Box(1)
    a = b swap Box(q)
    var Box d = mov a swap Box(q + 1)
    return d.value
}
`;
	const parsed = parse_raw(input);
	for (const err of parsed.errors)
		throw new Error(`parse error @${err.line}:${err.column}: ${err.message}`);
	const fn = parsed.root.statements.find(
		(s) => s.node_type === "func" && (s as FunctionNode).name === "swapper",
	) as FunctionNode;
	const lowered = lower_function(fn);
	expect([...lowered.unknown_kinds]).toEqual([]);

	// `a = b swap Box(q)` — the replacement rides the assign variant.
	const assign = lowered.body.find((s) => s.kind === "assign");
	expect(assign && assign.kind === "assign").toBe(true);
	if (assign!.kind !== "assign") return;
	expect(assign!.swap).not.toBeNull();
	expect(assign!.swap!.node.node_type).toBe("func_call");

	// `var Box d = mov a swap Box(q + 1)` — the replacement rides the declare.
	const decl = lowered.body.find((s) => s.kind === "declare" && s.decl.swap !== null);
	expect(decl && decl.kind === "declare").toBe(true);

	// Parity pin: `q` is read ONLY inside swap exprs here, and the historical
	// func_flow scan never saw assignment swap exprs — traffic must keep
	// promotion inputs byte-stable by NOT counting them.
	const report = analyze_traffic(lowered);
	expect(report.variables.get("q")?.reads ?? 0).toBe(0);
});

test("value-position match/if/switch lower to flow with empty unknown kinds", () => {
	const input = `
pub func flow_demo = (int v, out int) {
    var int kind = match v {
        case 0 -> 100
        else -> 300
    }
    var int bump = if kind > 150 -> 5
                   else -> 1
    var int wrap = switch {
        case kind == 100 -> 7
        else -> 9
    }
    return kind + bump + wrap
}
`;
	const parsed = parse_raw(input);
	for (const err of parsed.errors)
		throw new Error(`parse error @${err.line}:${err.column}: ${err.message}`);
	const fn = parsed.root.statements.find(
		(s) => s.node_type === "func" && (s as FunctionNode).name === "flow_demo",
	) as FunctionNode;
	const lowered = lower_function(fn);
	expect([...lowered.unknown_kinds]).toEqual([]);
	const inits = lowered.body
		.filter((s) => s.kind === "declare")
		.map((s) => (s.kind === "declare" ? s.decl.init : null));
	// match: scrutinee-free? No — match HAS a scrutinee (v); switch has none.
	const match_init = inits[0];
	expect(match_init?.kind).toBe("flow");
	if (match_init?.kind === "flow") {
		expect(match_init.scrutinee?.kind).toBe("leaf");
		expect(match_init.arms.length).toBe(1);
		expect(match_init.otherwise?.length).toBe(1);
	}
	const if_init = inits[1];
	expect(if_init?.kind).toBe("flow");
	if (if_init?.kind === "flow") {
		expect(if_init.arms.length).toBe(1);
		expect(if_init.arms[0].condition?.kind).toBe("binary");
	}
	const switch_init = inits[2];
	expect(switch_init?.kind).toBe("flow");
	if (switch_init?.kind === "flow") {
		expect(switch_init.scrutinee).toBeNull();
	}
});

test("value-position spawn lowers to the spawn expr carrying its call", () => {
	const input = `
func work = (uint64 arg) {}
pub func spawn_value = (out uint64) {
    var t = spawn work(3)
    return t.result_uint64()
}
`;
	const parsed = parse_raw(input);
	const fn = parsed.root.statements.find(
		(s) => s.node_type === "func" && (s as FunctionNode).name === "spawn_value",
	) as FunctionNode;
	const lowered = lower_function(fn);
	expect([...lowered.unknown_kinds]).toEqual([]);
	const decl = lowered.body.find((s) => s.kind === "declare");
	expect(decl && decl.kind === "declare" && decl.decl.init?.kind === "spawn").toBe(true);
	if (decl!.kind !== "declare" || decl!.decl.init?.kind !== "spawn") return;
	expect(decl!.decl.init.call.kind).toBe("call");
});

test("nested type declarations lower to opaque without recording unknown kinds", () => {
	const input = `
pub func nested_types = (out int) {
    var int v = 3
    struct P {
        var int x
    }
    enum E {
        case a
        case b
    }
    bitset B {
        case f1
        case f2
    }
    return v
}
`;
	const parsed = parse_raw(input);
	const fn = parsed.root.statements.find(
		(s) => s.node_type === "func" && (s as FunctionNode).name === "nested_types",
	) as FunctionNode;
	const lowered = lower_function(fn);
	expect([...lowered.unknown_kinds]).toEqual([]);
	const opaque_count = lowered.body.filter((s) => s.kind === "opaque").length;
	expect(opaque_count).toBe(3);
	// The executable statements around the type declarations still lower.
	expect(lowered.body[0].kind).toBe("declare");
	expect(lowered.body[lowered.body.length - 1].kind).toBe("return");
});

test("traffic counts flow-arm and spawn-arg reads (flip pin)", () => {
	const input = `
pub func parity = (int q, out int) {
    var int k = match 1 {
        case 1 -> q
        else -> 0
    }
    return k
}
pub func parity_spawn = (int q) {
    var t = spawn work(q)
    t.wait()
}
func work = (int arg) {}
`;
	const parsed = parse_raw(input);
	for (const name of ["parity", "parity_spawn"]) {
		const fn = parsed.root.statements.find(
			(s) => s.node_type === "func" && (s as FunctionNode).name === name,
		) as FunctionNode;
		const report = analyze_traffic(lower_function(fn));
		// `q` appears ONLY inside a flow arm / spawn argument — the
		// ASM_PLAN_4 traffic flip counts these (they execute on every
		// evaluation, so the allocators' read inputs are now honest).
		expect(report.variables.get("q")?.reads ?? 0, name).toBe(1);
	}
});
