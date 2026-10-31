import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { scan_last_use_string_moves } from "../src/check/utils/last_use";
import { set_move_on_last_use_enabled } from "../src/check/utils/last_use";
import build_and_check_output from "./build_and_check_output";
import { parse_program, parse_raw } from "./parse_with_imports";

// Move-on-last-use for structs (PERF_PLAN item 3): `a = b.copy()` /
// `var a = b.copy()` where the checker resolved the SYNTHESIZED deep-copy
// method and `b` is provably dead after the site rewrites the RHS to
// `mv b` — the explicit-transfer lowering both backends already implement
// (donor cleanup suppressed, displaced-value reclaim kept) replaces the
// per-field deep copy (strdup per string field, fresh container per List
// field). Every guard mirrors the string pass's posture: it may MISS a
// last use, never invent one.

const LOOP_DONOR = `
import System

mv struct Row {
	var name = ""
	var tags = List<int>()
}

func fill = (int i, out Row) {
	var src = Row()
	src.name = "row\\{i}"
	src.tags.push(i)
	src.tags.push(i * 10)
	return src
}

pub func main = (Init init) {
	var acc = 0
	var int i = 0
	while i < 6 {
		var src = fill(i)
		var dst = src.copy()
		acc = acc + dst.tags.pop()
		i += 1
	}
	Console.write("\\{acc}")
}
`;

describe("struct move-on-last-use: readback", () => {
	test("loop-local donor transfers instead of deep-copying", async () => {
		// acc = (0+1+2+3+4+5) * 10 — the transferred rows stay intact (the
		// string field reads back through dst.name's owner, the List pops in
		// order), and the audit ledger asserts the transfer leaks nothing and
		// frees nothing twice.
		await build_and_check_output(LOOP_DONOR, "struct_lu_loop_donor", "150", true);
	});

	test("return-site donor transfers instead of deep-copying", async () => {
		// `return src.copy()` at src's last use: the synthesized copy is
		// elided, the donor's bytes transfer to the caller. Each iteration
		// reads back through the transferred fields (audit on: exactly-once
		// release).
		const input = `
import System

mv struct Rec {
	var name = ""
	var n = 0
}

func make = (int i, out Rec) {
	var src = Rec()
	src.name = "r\\{i}"
	src.n = i * 2
	return src.copy()
}

pub func main = (Init init) {
	var acc = 0
	var int i = 0
	while i < 5 {
		var r = make(i)
		acc = acc + r.n + r.name.length
		i += 1
	}
	Console.write("\\{acc}")
}
`;
		// (0+1+...+4)*2 + 5*2 = 20 + 10 = 30
		await build_and_check_output(input, "struct_lu_return", "30", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).not.toMatch(/Rec_copy\(&/);
	});

	test("container-store donor transfers instead of deep-copying", async () => {
		// `list.push(src.copy())` at src's last use: the push's `mv T value`
		// parameter takes the donor's state — the checker-hoisted `_param_N`
		// copy temp drops out (audit on: every element released exactly once).
		const input = `
import System

mv struct Rec {
	var name = ""
	var n = 0
}

pub func main = (Init init) {
	var list = List<Rec>()
	var acc = 0
	var int i = 0
	while i < 5 {
		var src = Rec()
		src.name = "r\\{i}"
		src.n = i
		list.push(src.copy())
		i += 1
	}
	while list.length > 0 {
		var r = list.pop()
		acc = acc + r.n
	}
	Console.write("\\{acc}")
}
`;
		await build_and_check_output(input, "struct_lu_push", "10", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).not.toMatch(/Rec_copy\(&/);
	});

	test("field-store donor transfers instead of deep-copying", async () => {
		// `holder.r = src.copy()` at src's last use: the field takes the
		// donor's state (audit on: the displaced field value released, the
		// donor not double-released).
		const input = `
import System

mv struct Rec {
	var name = ""
	var n = 0
}

mv struct Holder {
	var r = Rec()
	var tag = 0
}

pub func main = (Init init) {
	var h = Holder()
	h.tag = 9
	var acc = 0
	var int i = 0
	while i < 4 {
		var src = Rec()
		src.name = "r\\{i}"
		src.n = i
		h.r = src.copy()
		acc = acc + h.r.n + h.tag
		i += 1
	}
	Console.write("\\{acc}\\{h.r.name}")
}
`;
		// (0+1+2+3) + 4*9 = 6 + 36 = 42, name = r3
		await build_and_check_output(input, "struct_lu_field", "42r3", true);
	});

	test("container-typed donor (List) transfers instead of deep-copying", async () => {
		// `var dst = list.copy()` at list's last use: the container mv
		// transfer hands the slab over — the library copy malloc drops out.
		const input = `
import System

pub func main = (Init init) {
	var acc = 0
	var int i = 0
	while i < 5 {
		var list = List<int>()
		list.push(i)
		list.push(i * 10)
		var dst = list.copy()
		acc = acc + dst.pop()
		i += 1
	}
	Console.write("\\{acc}")
}
`;
		// 10+20+30+40+50 = 100
		await build_and_check_output(input, "struct_lu_list_donor", "100", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		// The definition is still emitted (unconditional); nothing calls it.
		expect(result.code).toContain("List_int_copy(struct List_int *self)");
		expect(result.code).not.toMatch(/List_int_copy\(&/);
	});

	test("free-call mv-param donor transfers instead of deep-copying", async () => {
		// `consume(src.copy())` where consume takes `mv Rec`: the rewritten
		// argument is the explicit `mv src` donor spelling — no `_param_N`
		// copy temp, no synthesized copy (audit on).
		const input = `
import System

mv struct Rec {
	var name = ""
	var n = 0
}

func consume = (mv Rec r, out int) {
	return r.n
}

pub func main = (Init init) {
	var acc = 0
	var int i = 0
	while i < 5 {
		var src = Rec()
		src.name = "r\\{i}"
		src.n = i * 3
		var got = consume(src.copy())
		acc = acc + got
		i += 1
	}
	Console.write("\\{acc}")
}
`;
		// (0+1+2+3+4)*3 = 30
		await build_and_check_output(input, "struct_lu_call_arg", "30", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).not.toMatch(/Rec_copy\(&/);
	});

	test("assignment form transfers and reads back", async () => {
		const input = `
import System

mv struct Pair {
	var name = ""
	var a = 0
}

pub func main = (Init init) {
	var p1 = Pair()
	p1.name = "hello"
	p1.a = 7
	var p2 = Pair()
	p2.name = "world"
	p2 = p1.copy()
	Console.write("\\{p2.name} \\{p2.a}")
}
`;
		await build_and_check_output(input, "struct_lu_assign_readback", "hello 7", true);
	});

	test("nested-copyable field transfers without deep copies", async () => {
		const input = `
import System

mv struct Inner {
	var text = ""
}

mv struct Outer {
	var name = ""
	var inner = Inner()
}

pub func main = (Init init) {
	var o = Outer()
	o.name = "x"
	o.inner.text = "deep"
	var p = o.copy()
	Console.write("\\{p.name} \\{p.inner.text}")
}
`;
		// The synthesized copy recurses (inner routes through Inner.copy), so
		// the whole subtree transfers in one move.
		await build_and_check_output(input, "struct_lu_nested_copy", "x deep", true);
	});
});

describe("struct move-on-last-use: guards keep the deep copy", () => {
	test("a later read of the donor keeps the copy", async () => {
		const input = `
import System

mv struct Pair {
	var name = ""
	var a = 0
}

pub func main = (Init init) {
	var p1 = Pair()
	p1.name = "hello"
	var p2 = p1.copy()
	Console.write("\\{p2.name}/\\{p1.name}")
}
`;
		await build_and_check_output(input, "struct_lu_later_read", "hello/hello", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).toMatch(/Pair_copy\(&p1\)/);
	});

	test("a back-edge re-read of an outer-binding donor keeps the copy", async () => {
		const input = `
import System

mv struct Pair {
	var name = ""
	var a = 0
}

pub func main = (Init init) {
	var keep = Pair()
	keep.name = "k"
	var acc = 0
	var int i = 0
	while i < 3 {
		var d = keep.copy()
		acc = acc + d.a
		i += 1
	}
	Console.write("\\{acc}\\{keep.name}")
}
`;
		await build_and_check_output(input, "struct_lu_back_edge", "0k", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).toMatch(/Pair_copy\(&keep\)/);
	});

	test("self-assignment keeps the copy (the RHS reads the target)", () => {
		const input = `
import System

mv struct Pair {
	var name = ""
	var a = 0
}

pub func main = (Init init) {
	var p = Pair()
	p.name = "self"
	p = p.copy()
	Console.write(p.name)
}
`;
		// Emission-level pin only: a plain `p = p.copy()` has a pre-existing
		// displaced-value bug of its own (FOLLOWUP.md), so this asserts the
		// REWRITE decision — the copy must be kept — without pinning that.
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).toMatch(/Pair_copy\(&p\)/);
	});

	test("a const donor and a param donor keep the copy", async () => {
		const input = `
import System

mv struct Rec {
	var name = ""
	var n = 0
}

func probe = (mv Rec r, out int) {
	var d = r.copy()
	return d.n
}

pub func main = (Init init) {
	const c = Rec()
	var d1 = c.copy()
	var d2 = Rec()
	d2.n = 5
	Console.write("\\{d1.n}\\{probe(mv d2)}")
}
`;
		await build_and_check_output(input, "struct_lu_const_param", "05", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		// The const-donor site keeps its copy; the param-donor site (inside
		// probe, where the mv param is a pointer) keeps its copy too.
		expect(result.code).toMatch(/Rec_copy\(&c\)/);
		expect(result.code).toMatch(/Rec_copy\(r\)/);
	});

	test("return-site guard: a later read of the donor keeps the copy", async () => {
		const input = `
import System

mv struct Rec {
	var name = ""
	var n = 0
}

func make = (int i, out Rec) {
	var src = Rec()
	src.name = "r\\{i}"
	src.n = i
	var r = src.copy()
	Console.write("\\{src.n}")
	return r
}

pub func main = (Init init) {
	Console.write("\\{make(3).n}")
}
`;
		await build_and_check_output(input, "struct_lu_return_guard", "33", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).toMatch(/Rec_copy\(&src\)/);
	});

	test("container-store guard: a later read of the donor keeps the copy", async () => {
		const input = `
import System

mv struct Rec {
	var name = ""
	var n = 0
}

pub func main = (Init init) {
	var list = List<Rec>()
	var src = Rec()
	src.n = 4
	list.push(src.copy())
	Console.write("\\{src.n}")
	Console.write("\\{list.pop().n}")
}
`;
		await build_and_check_output(input, "struct_lu_push_guard", "44", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).toMatch(/Rec_copy\(&src\)/);
	});

	test("field-store guard: a later read of the donor keeps the copy", async () => {
		const input = `
import System

mv struct Rec {
	var name = ""
	var n = 0
}

mv struct Holder {
	var r = Rec()
	var tag = 0
}

pub func main = (Init init) {
	var h = Holder()
	h.tag = 5
	var src = Rec()
	src.n = 2
	h.r = src.copy()
	Console.write("\\{src.n}\\{h.r.n + h.tag}")
}
`;
		// The kept copy is a real deep copy whose displaced seed must be
		// reclaimed at the store (audit on: the displaced h.r.name free runs
		// exactly once and the copy's strdup is released at scope exit).
		await build_and_check_output(input, "struct_lu_field_guard", "27", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).toMatch(/Rec_copy\(&src\)/);
	});

	test("container-donor guard: a later read of the list keeps the copy", async () => {
		const input = `
import System

pub func main = (Init init) {
	var list = List<int>()
	list.push(7)
	var dst = list.copy()
	Console.write("\\{dst.pop()}\\{list.pop()}")
}
`;
		await build_and_check_output(input, "struct_lu_list_guard", "77", true);
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).toMatch(/List_int_copy\(&list\)/);
	});

	test("a raw body in the copy's own function refuses every rewrite", async () => {
		const input = `
import System

mv struct Pair {
	var name = ""
	var a = 0
}

pub func main = (Init init) {
	var p1 = Pair()
	p1.name = "x"
	\`\`\`
	#arch: c
	(void)0;
	\`\`\`
	\`\`\`
	#arch: aarch64
	mov x0, x1
	\`\`\`
	var p2 = p1.copy()
	Console.write("\\{p2.name}")
}
`;
		await build_and_check_output(input, "struct_lu_raw_refusal", "x", true);
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.code).toMatch(/Pair_copy\(&p1\)/);
	});
});

describe("struct move-on-last-use: lowering shape", () => {
	test("C backend lowers the last-use copy as the plain transfer", () => {
		const parsed = parse_program(LOOP_DONOR);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		// The synthesized deep copy is still emitted (its definition is
		// unconditional) but nothing calls it from the loop body.
		expect(code).toContain("struct Row Row_copy(struct Row *self)");
		expect(code).not.toMatch(/Row_copy\(&/);
		// The transfer is the explicit-mv lowering: the plain byte copy from
		// the donor, and the donor's own auto-free spliced away (it owns
		// nothing after the transfer).
		expect(code).toContain("struct Row dst = src;");
		expect(code).toMatch(
			/struct Row dst = src;\n[\s\S]*?if \(!_mv_owns_dst\) \{ free\(dst\.name\.ptr\);/,
		);
		expect(code).not.toMatch(/if \(!_mv_owns_src\) \{ free\(src\.name\.ptr\);/);
	});

	test("aarch64 backend lowers the last-use copy as the word-copy transfer", () => {
		const parsed = parse_program(LOOP_DONOR);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		expect(code).not.toContain("bl Row_copy");
	});

	test("the kill-switch restores the deep copy on rebuild", () => {
		const parsed = parse_program(LOOP_DONOR);
		expect(parsed.errors).toEqual([]);

		const moved = build(parsed.root, { arch: "c" });
		expect(moved.errors ?? []).toEqual([]);
		expect(moved.code).not.toMatch(/Row_copy\(&/);

		set_move_on_last_use_enabled(false);
		try {
			const copied = build(parsed.root, { arch: "c" });
			expect(copied.errors ?? []).toEqual([]);
			expect(copied.code).toMatch(/Row_copy\(&src\)/);
		} finally {
			set_move_on_last_use_enabled(true);
		}

		// Switching back on re-fires the rewrite (idempotent across builds
		// of the same shared AST).
		const again = build(parsed.root, { arch: "c" });
		expect(again.errors ?? []).toEqual([]);
		expect(again.code).not.toMatch(/Row_copy\(&/);
	});
});

describe("struct move-on-last-use: scanner receipt", () => {
	test("the scanner reports last-use struct copy sites", () => {
		const parsed = parse_program(LOOP_DONOR);
		expect(parsed.errors).toEqual([]);
		const sites = scan_last_use_string_moves(parsed.root);
		expect(sites.map((s) => s.desc)).toEqual(["var dst = src.copy()"]);
	});

	test("guarded shapes report nothing", () => {
		const guarded = `
import System

mv struct Pair {
	var name = ""
	var a = 0
}

pub func main = (Init init) {
	var p1 = Pair()
	p1.name = "hello"
	var p2 = Pair()
	p2 = p1.copy()
	Console.write_line(p1.name)
	var int i = 0
	var keep = Pair()
	keep.name = "k"
	while i < 3 {
		var d = keep.copy()
		i += 1
	}
	Console.write_line(keep.name)
}
`;
		const parsed = parse_program(guarded);
		expect(parsed.errors).toEqual([]);
		expect(scan_last_use_string_moves(parsed.root)).toHaveLength(0);
	});
});
