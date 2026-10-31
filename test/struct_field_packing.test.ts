import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import {
	packed_own_fields,
	packing_alignment,
	struct_packs_fields,
} from "../src/build_common/struct_packing";
import type DeclarationNode from "../src/nodes/DeclarationNode";
import type FunctionNode from "../src/nodes/FunctionNode";
import type Type from "../src/nodes/Type";
import build_and_check_output from "./build_and_check_output";
import { parse_program } from "./parse_with_imports";

// Struct field-order packing (PERF_PLAN item 12). Fields historically laid
// out in DECLARATION order carry alignment padding (`{ int64 a; bool f;
// int64 b; bool g; }` is 40 bytes instead of 32), and every List slot,
// memcpy, and ctor copy pays the inflated stride. The layout view packs each
// struct's own fields by ALIGNMENT DESCENDING — stable for equal alignments,
// so all-word structs keep their declaration order byte-for-byte — while
// `struct.fields` stays in declaration order (the positional #init contract).
// Structs with raw `#arch` bodies (which hardcode field offsets), tuples, and
// fixed-array fields keep declaration order.
//
// Because every type's size is a multiple of its natural alignment in this
// type system, the packed order is gap-free: the aligned layout walk, the C
// typedef's naturally-aligned members, and the raw unaligned cursor walks in
// the owning-buffer/destroy specializations all agree on every offset.

const t = (name: string, extra: Partial<Type> = {}): Type =>
	({ name, ...extra }) as unknown as Type;

const f = (name: string, type: Type): DeclarationNode =>
	({ name, type }) as unknown as DeclarationNode;

function build_c(source: string): string {
	const parsed = parse_program(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "c", audit: false });
	expect(result.errors ?? []).toEqual([]);
	return result.headers + "\n" + result.code;
}

function build_aarch64(source: string): string {
	const parsed = parse_program(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", audit: false });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const PADDED_PROGRAM = `
import System

struct Padded {
	var int a
	var bool f
	var int b
	var bool g
}

pub func main = (Init init) {
	var l = List<Padded>()
	l.push(Padded(1, true, 2, false))
	l.push(Padded(3, false, 4, true))
	var int sum = 0
	var int j = 0
	while j < l.length; j += 1 {
		var Padded p = l.at(j)
		if p.f { sum += 1 }
		if p.g { sum += 2 }
		sum += p.a + p.b
	}
	Console.write("\\{sum}")
}
`;

describe("packing order (unit)", () => {
	test("fields sort by alignment descending, stable within equal alignment", () => {
		const struct = {
			name: "Padded",
			fields: [
				f("a", t("int64")),
				f("flag", t("bool")),
				f("b", t("int64")),
				f("flag2", t("bool")),
				f("half", t("int32")),
			],
		};
		expect(packed_own_fields(struct).map((x) => x.name)).toEqual([
			"a",
			"b",
			"half",
			"flag",
			"flag2",
		]);
	});

	test("all-word structs keep declaration order (stable sort)", () => {
		const fields = [f("a", t("int")), f("s", t("string")), f("b", t("float"))];
		const struct = { name: "Words", fields };
		expect(packed_own_fields(struct)).toEqual(fields);
	});

	test("alignment mirror: sub-8 scalars align to their width, everything else to 8", () => {
		expect(packing_alignment(t("bool"))).toBe(1);
		expect(packing_alignment(t("char"))).toBe(1);
		expect(packing_alignment(t("int16"))).toBe(2);
		expect(packing_alignment(t("uint32"))).toBe(4);
		expect(packing_alignment(t("int"))).toBe(8);
		expect(packing_alignment(t("string"))).toBe(8);
		expect(packing_alignment(t("float32"))).toBe(8);
		// a view OF a sub-8 scalar is still the 16-byte (ptr, len) pair
		expect(packing_alignment(t("char", { is_view: true }))).toBe(8);
		// fixed arrays align to 8 (the aarch64 length-header layout)
		expect(packing_alignment(t("char", { is_array: true }))).toBe(8);
		expect(packing_alignment(t("Inner", { is_ref: true }))).toBe(8);
	});

	test("structs with raw bodies keep declaration order", () => {
		const fields = [f("a", t("int64")), f("flag", t("bool")), f("b", t("int64"))];
		const with_raw = {
			name: "Raw",
			fields,
			functions: [{ statements: [{ node_type: "raw" }] }] as unknown as FunctionNode[],
		};
		expect(struct_packs_fields(with_raw)).toBe(false);
		expect(packed_own_fields(with_raw)).toBe(fields);
	});

	test("tuples and fixed-array fields keep declaration order", () => {
		const fields = [f("a", t("int64")), f("flag", t("bool")), f("b", t("int64"))];
		expect(struct_packs_fields({ name: "_Tuple_int_bool", fields })).toBe(false);
		expect(
			struct_packs_fields({
				name: "Arr",
				fields: [...fields, f("buf", t("char", { is_array: true }))],
			}),
		).toBe(false);
		expect(packed_own_fields({ name: "_Tuple_int_bool", fields })).toBe(fields);
	});
});

describe("packed layout emission", () => {
	test("C typedef emits members in packed order", () => {
		const code = build_c(PADDED_PROGRAM);
		const body = code.match(/typedef struct Padded\n\{\n([\s\S]*?)\n\} Padded;/);
		expect(body).not.toBeNull();
		const members = body![1]
			.split("\n")
			.map((l) => l.trim().split(" ").pop()?.replace(";", "").replace(/^\*/, ""));
		// declaration order is a, f, b, g — the packed layout puts the words
		// first and collects the bools into the old tail padding
		expect(members).toEqual(["_vt", "a", "b", "f", "g"]);
	});

	test("aarch64: the List stride is the packed size (32, not 40)", () => {
		const code = build_aarch64(PADDED_PROGRAM);
		// T_SIZE substitutes into List's raw slot arithmetic: 8 (VT) + 8 + 8
		// + 1 + 1 = 26 → tail-padded 32. The declaration-order layout is 40.
		expect(code).toContain("mov x3, #32\n");
		expect(code).not.toContain("mov x3, #40\n");
		// the stride multiply folds to a shift for the power-of-two size
		expect(code).toContain("lsl x1, x1, #5\n");
	});

	test("aarch64: ctor bool stores land at the packed offsets", () => {
		const code = build_aarch64(PADDED_PROGRAM);
		// packed: a@8, b@16, f@24, g@25 (declaration order would be f@16, g@32)
		expect(code.match(/strb w\d+, \[x\d+, #24\]/)).not.toBeNull();
		expect(code.match(/strb w\d+, \[x\d+, #25\]/)).not.toBeNull();
		expect(code.match(/strb w\d+, \[x\d+, #16\]/)).toBeNull();
		expect(code.match(/strb w\d+, \[x\d+, #32\]/)).toBeNull();
	});
});

describe("packed layout runtime (both backends, audit on)", () => {
	test("fields read back through the packed layout", async () => {
		await build_and_check_output(PADDED_PROGRAM, "packed_fields_read", "13", true);
	});

	test("strings and containers in a packed struct survive copies and destroys", async () => {
		// The destroy/strdup/copy walks must free exactly the packed offsets:
		// a string field and an owned List field with bools interleaved.
		// Packed: xs@8, name@48, hot@64, tag@65 (T_SIZE 72). Each owning read
		// walks the deep-copy path over the packed layout; the scope destroys
		// reclaim the copies' packed fields.
		const input = `
import System

mv struct Rec {
	var string name
	var bool hot
	var List<int> xs
	var bool tag
}

pub func main = (Init init) {
	var l = List<Rec>()
	l.push(Rec("a", true, List<int>(), false))
	l.push(Rec("b", false, List<int>(), true))
	var int i = 0
	while i < l.length; i += 1 {
		var Rec r = l.at(i)
		r.xs.push(40 + i)
		var string line = r.name + ":" + r.xs.length.to_string()
		if r.hot { line = line + "h" }
		if r.tag { line = line + "t" }
		Console.write(line + " ")
	}
	var Rec s = Rec("c", false, List<int>(), true)
	s.xs.push(9)
	var Rec t = s.copy()
	t.name = "d"
	t.xs.push(10)
	Console.write(s.name + ":" + s.xs.length.to_string() + " ")
	Console.write(t.name + ":" + t.xs.length.to_string())
	if t.tag { Console.write("t") }
}
`;
		await build_and_check_output(input, "packed_fields_ownership", "a:1h b:1t c:1 d:2t", true);
	});

	test("a packed struct in a Map round-trips", async () => {
		const input = `
import System

struct Pair {
	var int64 key
	var bool on
	var int64 val
}

pub func main = (Init init) {
	var m = Map<string, Pair>()
	m.set("x", Pair(1, true, 10))
	m.set("y", Pair(2, false, 20))
	var Pair p = m.get_or_panic("x")
	var Pair q = m.get_or_panic("y")
	Console.write("\\{p.key}\\{p.val}\\{q.key}\\{q.val}")
	if p.on { Console.write("on") }
	if q.on { Console.write("qon") }
}
`;
		await build_and_check_output(input, "packed_map_roundtrip", "110220on", true);
	});
});
