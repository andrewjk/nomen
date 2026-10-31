import { describe, expect, test } from "vite-plus/test";

import build, { default_platform } from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// The in-place construction guarantee, container-store tranche: a
// `set(i, f(x))` / `map.set(k, f(x))` whose value argument is a direct call
// of the element type constructs the result straight into the destination
// slot — no `_param_N` temp home, no callee-side deep copy, no temp free.
// List/Buffer address the slot with `slot_ptr(i)` and reclaim the displaced
// value through it (the destroy half of replace); Map's `set_slot_ptr(key)`
// runs the whole set preamble + probe + insert bookkeeping (or the
// displaced reclaim via `values.destroy_at`) and returns the value slot —
// the key precedes the value in evaluation order, so the probe precedes the
// construct end to end. Scalars keep the hoisted path (nothing to elide).

describe("in-place store: List.set with string elements", () => {
	test("set of a call result reads back, displaced value freed", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push(fake_parse("a"))
	items.push(fake_parse("b"))
	var int i = 0
	while i < items.length; i += 1 {
		items.set(i, fake_parse("x\\{i}"))
	}
	Console.write("\\{items.at_or(0, "?")}\\{items.at_or(1, "?")}")
}
`;
		await build_and_check_output(input, "inplace_set_string_readback", "x0x1", true);
	});

	test("set across the growth boundary", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	var int i = 0
	while i < 12; i += 1 {
		items.push(fake_parse("\\{i}"))
	}
	var int j = 0
	while j < items.length; j += 1 {
		items.set(j, fake_parse("s\\{j}"))
	}
	var string acc = ""
	var int k = 0
	while k < items.length; k += 1 {
		acc = acc + items.at_or(k, "?")
	}
	Console.write(acc)
}
`;
		await build_and_check_output(
			input,
			"inplace_set_string_growth",
			"s0s1s2s3s4s5s6s7s8s9s10s11",
			true,
		);
	});
});

describe("in-place store: List.set with value-struct elements", () => {
	test("set of a ctor result into a struct slot", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int a
	var int b
}

pub func main = (Init init) {
	var List<Rec> recs = List<Rec>()
	recs.push(Rec("old0", 0, 0))
	recs.push(Rec("old1", 1, 1))
	var int i = 0
	while i < recs.length; i += 1 {
		recs.set(i, Rec("new\\{i}", i * 2, i * 3))
	}
	// Pop readback: a moved-out element owns its fields, so the pins avoid
	// the pre-existing load-borrow teardown hazard (FOLLOWUP.md).
	var int total = 0
	while recs.length > 0 {
		var Rec r = recs.pop()
		total = total + r.a + r.b
	}
	Console.write("\\{total}")
}
`;
		await build_and_check_output(input, "inplace_set_struct_readback", "5", true);
	});

	test("displaced struct value is destroyed exactly once", async () => {
		// Every slot is overwritten in place, then the whole list is
		// drained — audit counts one owner per heap string: the displaced
		// values must be reclaimed by the store (not leaked, not
		// double-freed at list teardown).
		const input = `
import System

mv struct Rec {
	var string name
	var int a
}

pub func main = (Init init) {
	var List<Rec> recs = List<Rec>()
	var int i = 0
	while i < 8; i += 1 {
		recs.push(Rec("seed\\{i}", i))
	}
	var int j = 0
	while j < recs.length; j += 1 {
		recs.set(j, Rec("over\\{j}", j))
	}
	var int total = 0
	while recs.length > 0 {
		var Rec r = recs.pop()
		total = total + r.a
	}
	Console.write("\\{total}")
}
`;
		await build_and_check_output(input, "inplace_set_struct_destroy", "28", true);
	});
});

describe("in-place store: Buffer.set", () => {
	test("buffer slot store of a call result", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Buffer<string> buf = Buffer<string>()
	buf.alloc(4)
	buf.set(0, fake_parse("a"))
	buf.set(1, fake_parse("b"))
	buf.set(0, fake_parse("A"))
	Console.write(buf.load(0))
	Console.write(buf.load(1))
	Console.write("\\n")
}
`;
		await build_and_check_output(input, "inplace_set_buffer", "Ab\n", true);
	});
});

describe("in-place store: Map.set probe-then-construct", () => {
	test("insert and replace paths read back", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Map<string, string> m = Map<string, string>()
	m.set("a", fake_parse("1"))
	m.set("b", fake_parse("2"))
	m.set("a", fake_parse("9"))
	Console.write("\\{m.get_or("a", "?")}\\{m.get_or("b", "?")}\\{m.get_or("c", "?")}\\{m.length}")
}
`;
		// The "a" replace path runs set_slot_ptr's displaced reclaim; the
		// insert path runs the bookkeeping. Audit on: the displaced "1" must
		// be freed exactly once.
		await build_and_check_output(input, "inplace_map_set_readback", "92?2", true);
	});

	test("replace path across rehash growth", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Map<int, string> m = Map<int, string>()
	var int i = 0
	while i < 40; i += 1 {
		m.set(i, fake_parse("v\\{i}"))
	}
	var int j = 0
	while j < 40; j += 1 {
		m.set(j, fake_parse("w\\{j}"))
	}
	var string acc = ""
	var int k = 0
	while k < 40; k += 1 {
		acc = acc + m.get_or(k, "?")
	}
	Console.write(acc)
	Console.write("\\n\\{m.length}")
}
`;
		await build_and_check_output(
			input,
			"inplace_map_set_rehash",
			"w0w1w2w3w4w5w6w7w8w9w10w11w12w13w14w15w16w17w18w19w20w21w22w23w24w25w26w27w28w29w30w31w32w33w34w35w36w37w38w39\n40",
			true,
		);
	});

	test("container values: ctor result into the probed slot", async () => {
		// A container element makes the replace path reclaim a whole
		// displaced List through `values.destroy_at` (its slab + slots) —
		// audit-clean on both backends. (A user-struct element is
		// unreachable in-source today: declaring `Map<string, SomeStruct>`
		// poisons every later `SomeStruct(...)` ctor call — pre-existing,
		// FOLLOWUP.md.)
		const input = `
import System

func make = (int a, int b, out List<int>) {
	var List<int> v = List<int>()
	v.push(a)
	v.push(b)
	return v
}

func total = (Map<string, List<int>> m, out int) {
	var int acc = 0
	var List<int> v = m.get_or("k", List<int>())
	var int i = 0
	while i < v.length; i += 1 {
		acc = acc + v.at_or(i, 0)
	}
	return acc
}

pub func main = (Init init) {
	var Map<string, List<int>> m = Map<string, List<int>>()
	m.set("k", make(1, 2))
	m.set("k", make(30, 40))
	Console.write("\\{total(m)}")
}
`;
		await build_and_check_output(input, "inplace_map_set_container", "70", true);
	});
});

describe("in-place store: shapes that keep the hoisted lowering", () => {
	test("scalar elements keep the set callee", async () => {
		const input = `
import System

pub func main = (Init init) {
	var List<int> xs = List<int>()
	xs.push(1)
	xs.push(2)
	var int i = 0
	while i < xs.length; i += 1 {
		xs.set(i, i * 10)
	}
	Console.write("\\{xs.at_or(0, -1)}\\{xs.at_or(1, -1)}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		// Scalars have nothing to elide: the ordinary set callee runs.
		expect(code).toContain("List_int_set(&xs");
		await build_and_check_output(input, "inplace_set_scalar_unchanged", "010", true);
	});

	test("method-call value arguments keep the hoisted lowering", async () => {
		const input = `
import System

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push("a")
	items.push("b")
	var int i = 0
	while i < items.length; i += 1 {
		items.set(i, items.at_or(i, "?").copy())
	}
	Console.write("\\{items.at_or(0, "?")}\\{items.at_or(1, "?")}")
}
`;
		// A method call's receiver could alias the container — the hoisted
		// path stays (the same rule as push).
		await build_and_check_output(input, "inplace_set_method_arg", "ab", true);
	});
});

describe("in-place store: lowering shape", () => {
	test("C backend: slot_ptr splice, displaced free, no temp, no set callee", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push(fake_parse("a"))
	var int i = 0
	while i < items.length; i += 1 {
		items.set(i, fake_parse("x"))
	}
	Console.write(items.at_or(0, "?"))
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: default_platform() });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		const at = code.indexOf("List_string_slot_ptr(&items");
		expect(at).toBeGreaterThan(0);
		// The splice: slot address → displaced free → construct-into-slot.
		expect(code).toContain("free(_nomen_islot->ptr)");
		expect(code).toMatch(/_nomen_islot = \w*fake_parse\(/);
		// No call site takes the hoisted set (the mono body may be emitted).
		expect(code).not.toContain("List_string_set(&items");
		// The splice itself carries no temp home — end the window at its
		// closing brace so the next statement's own temps don't bleed in.
		const seq = code.slice(at, code.indexOf("; }", at) + 3);
		expect(seq).not.toContain("_param_");
	});

	test("C backend: struct element reclaims through the slot guard", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int a
}

pub func main = (Init init) {
	var List<Rec> recs = List<Rec>()
	recs.push(Rec("old", 1))
	var int i = 0
	while i < recs.length; i += 1 {
		recs.set(i, Rec("new", 2))
	}
	Console.write(recs.at_or(0, Rec("?", -1)).name)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: default_platform() });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		expect(code).toContain("List_Rec_slot_ptr(&recs");
		// The `_vt` constructed-stamp guard skips grown-but-unwritten slots.
		expect(code).toContain("if (_nomen_islot->_vt) { Rec_destroy(_nomen_islot); }");
	});

	test("C backend: Map.set probes through set_slot_ptr", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Map<string, string> m = Map<string, string>()
	m.set("k", fake_parse("v"))
	Console.write(m.get_or("k", "?"))
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: default_platform() });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		expect(code).toContain("Map_string_string_set_slot_ptr(&m");
		expect(code).not.toContain("Map_string_string_set(&m");
		// The core primitive runs the displaced reclaim through destroy_at.
		expect(code).toContain("Buffer_string_destroy_at");
	});

	test("aarch64 backend: bl slot_ptr, pair store, no push machinery", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push(fake_parse("a"))
	var int i = 0
	while i < items.length; i += 1 {
		items.set(i, fake_parse("x"))
	}
	Console.write(items.at_or(0, "?"))
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: default_platform() });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		// Nomen symbols carry no `_` prefix in aarch64 asm (that is the C
		// backend's Mach-O convention).
		expect(code).toContain("bl List_string_slot_ptr");
		// The displaced reclaim frees the old pair, then the fresh pair
		// stores raw into the slot: bl slot_ptr → spill → bl free → bl
		// fake_parse → pair store. The bounded windows prove this sequence
		// is one statement — the set mono's body may exist (and set_or_panic
		// may call it internally), but this statement never does.
		expect(code).toMatch(
			/bl List_string_slot_ptr\n[\s\S]{0,200}?bl _free\n[\s\S]{0,200}?bl fake_parse\n[\s\S]{0,200}?str x0, \[x10\]\nstr x1, \[x10, #8\]\n/,
		);
	});

	test("aarch64 backend: Map.set bl set_slot_ptr", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Map<string, string> m = Map<string, string>()
	m.set("k", fake_parse("v"))
	Console.write(m.get_or("k", "?"))
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: default_platform() });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		expect(code).toContain("bl Map_string_string_set_slot_ptr");
		// (Map's own #init calls self.set internally — the mono body keeps
		// that call — so only the splice's set_slot_ptr bl is asserted.)
	});
});

describe("in-place store: still-correct programs that must not regress", () => {
	test("set_or_panic keeps its guarded callee", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push(fake_parse("a"))
	items.set_or_panic(0, fake_parse("z"))
	Console.write(items.at_or(0, "?"))
}
`;
		await build_and_check_output(input, "inplace_set_or_panic_unchanged", "z", true);
	});

	test("donor form keeps the ordinary transfer", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push(fake_parse("a"))
	var p = fake_parse("donor")
	if items.length > 0 {
		items.set(0, mv p)
	}
	Console.write(items.at_or(0, "?"))
}
`;
		// The donor spelling for set is NOT part of this tranche — it must
		// keep the ordinary (sound) mv transfer.
		await build_and_check_output(input, "inplace_set_donor_ordinary", "donor", true);
	});
});
