import { expect, test } from "vite-plus/test";

import collect_weighted_var_refs from "../src/build_aarch64/utils/func_flow";
import { plan_function_promotions } from "../src/build_aarch64/utils/func_regalloc";
import AssignmentNode from "../src/nodes/AssignmentNode";
import type BaseNode from "../src/nodes/BaseNode";
import FunctionNode from "../src/nodes/FunctionNode";
import OperationNode from "../src/nodes/OperationNode";
import Type from "../src/nodes/Type";
import ValueNode from "../src/nodes/ValueNode";
import WhileLoopNode from "../src/nodes/WhileLoopNode";
import parse from "../src/parse";

function ident(name: string): ValueNode {
	return new ValueNode(0, name);
}

function assign(left: string, right: BaseNode): AssignmentNode {
	return new AssignmentNode(0, ident(left), right);
}

function add(left: BaseNode, right: BaseNode): OperationNode {
	return new OperationNode(0, "+", left, right);
}

function func_of(statements: BaseNode[]): FunctionNode {
	return new FunctionNode(0, "pub", "f", new Type("void"), [], statements);
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
	const cond = ident("c");
	const wcond = ident("w");
	const body = [assign("h", add(ident("h"), ident("h")))];
	const wh = new WhileLoopNode(0, wcond, body);
	const iff: any = {
		node_type: "if",
		condition: cond,
		if_branch: { node_type: "branch", statements: [wh] },
		else_branch: undefined,
	};

	const info = collect_weighted_var_refs(
		func_of([decl, assign("h", add(ident("h"), ident("h"))), iff]),
	);

	// h: each `h = h + h` counts its LHS target + two RHS leaves (legacy
	// counting). Three reads at depth 0, three per loop pass at depth 1.
	expect(info.get("h")).toEqual({ reads: 6, weighted_reads: 3 * 8 + 3, address_taken: false });
	// The two conditions execute once per entry, not per statement pass.
	expect(info.get("c")?.reads).toBe(1);
	expect(info.get("w")?.weighted_reads).toBe(8);
});

test("address-take is reported for access receivers even inside branches", () => {
	// p.field = 1  →  p's address escapes via the access target
	const target = ident("p");
	const acc: any = { node_type: "access", target, access: undefined };
	const asgn = new AssignmentNode(0, acc as any, ident("1"));

	const info = collect_weighted_var_refs(
		func_of([
			{ node_type: "declare", name: "p", type: new Type("Point"), value: ident("Point()") } as any,
			asgn,
		]),
	);

	expect(info.get("p")?.address_taken).toBe(true);
});

test("method-call arguments count as reads (params, not args)", () => {
	const call_arg = ident("t");
	const push_call: any = {
		node_type: "access",
		target: ident("xs"),
		access: { node_type: "access_func", name: "push", params: [call_arg] },
	};

	const info = collect_weighted_var_refs(func_of([push_call as any]));
	expect(info.get("t")?.reads).toBe(1);
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
