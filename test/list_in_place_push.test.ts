import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// GOOSE.md #4 — the in-place construction guarantee, container-push tranche:
// `items.push(parse(line))` constructs the parsed record directly into the
// new slot (List.reserve, sret/pair-store into items.data[length], length
// bump) — no `_param_N` temp home, no callee-side slot copy, no temp free.
// The named-donor form (`const p = parse(line); items.push(p)`) keeps the
// hoisted lowering; both spellings converge on the same semantics.

describe("in-place push: string elements", () => {
	test("push of a call result reads back", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push(fake_parse("x"))
	items.push(fake_parse("y"))
	Console.write("\\{items.pop()}\\{items.pop()}")
}
`;
		await build_and_check_output(input, "inplace_push_string_readback", "yx", true);
	});

	test("push across the growth boundary", async () => {
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
	var string s = ""
	while items.length > 0 {
		s = s + items.pop()
	}
	Console.write(s)
}
`;
		// LIFO pops appended: 11, 10, …, 0.
		await build_and_check_output(input, "inplace_push_growth", "11109876543210", true);
	});

	test("named donor keeps the hoisted lowering and still works", async () => {
		const input = `
import System

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	var p = fake_parse("k")
	items.push(mv p)
	Console.write("\\{items.pop()}")
}
`;
		await build_and_check_output(input, "inplace_push_named_donor", "k", true);
	});

	test("method-call argument (pop) keeps the hoisted lowering", async () => {
		const input = `
import System

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push("a")
	items.push("b")
	items.push(items.pop())
	const c = items.pop()
	const d = items.pop()
	Console.write("\\{c}\\{d}\\{items.length}")
}
`;
		await build_and_check_output(input, "inplace_push_pop_arg", "ba0", true);
	});

	test("scalar pushes keep the ordinary lowering", async () => {
		const input = `
import System

func fake_int = (int k, out int) {
	return k * 2
}

pub func main = (Init init) {
	var List<int> nums = List<int>()
	nums.push(fake_int(21))
	const n = nums.pop()
	Console.write("\\{n}")
}
`;
		// Scalar elements are excluded from the in-place shape (nothing to
		// elide) — the ordinary hoisted lowering must keep working.
		await build_and_check_output(input, "inplace_push_scalar_excluded", "42", true);
	});
});

describe("in-place push: value-struct elements (sret into the slot)", () => {
	test("struct with a string field lands in the slot and survives", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int n
}

func make_rec = (string s, int k, out Rec) {
	return Rec(mv s.copy(), k)
}

pub func main = (Init init) {
	var List<Rec> recs = List<Rec>()
	recs.push(make_rec("a", 1))
	recs.push(make_rec("b", 2))
	recs.push(make_rec("c", 3))
	mv Rec r3 = recs.pop()
	mv Rec r2 = recs.pop()
	mv Rec r1 = recs.pop()
	Console.write("\\{r1.name}\\{r2.n}\\{r3.name}\\{r1.n}")
}
`;
		await build_and_check_output(input, "inplace_push_struct_slot", "a2c1", true);
	});

	test("plain int-field struct grows across the boundary", async () => {
		const input = `
import System

mv struct Vec {
	var int x
	var int y
}

func make_vec = (int x, int y, out Vec) {
	return Vec(x, y)
}

pub func main = (Init init) {
	var List<Vec> vs = List<Vec>()
	var int i = 0
	while i < 9; i += 1 {
		vs.push(make_vec(i, i * i))
	}
	mv Vec v = vs.pop()
	mv Vec w = vs.pop()
	Console.write("\\{vs.length}:\\{v.x},\\{v.y},\\{w.x}")
}
`;
		// Two pops: v = (8, 64) is the last push, w = (7, 49) precedes it;
		// seven elements remain.
		await build_and_check_output(input, "inplace_push_vec_growth", "7:8,64,7", true);
	});
});

describe("in-place push: lowering shape", () => {
	test("C backend reserves and constructs into the slot, no temp", async () => {
		const input = `
func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push(fake_parse("x"))
	Console.write("\\{items.pop()}")
}
`;
		const parsed = parse_with_imports(input, { allow_user_raw: true });
		const result = build(parsed.root, { arch: "c" });
		const code = result.code ?? "";
		const at = code.indexOf("List_string_reserve(&items");
		expect(at).toBeGreaterThan(0);
		// The push statement is reserve → construct-into-slot → length bump.
		expect(code).toContain("((nomen_string*)(unsigned long long)items.items.data)[items.length]");
		expect(code).toMatch(/items\.items\.data\)\[items\.length\] = \w*fake_parse\(/);
		expect(code).toContain("items.length += 1L");
		// No call site takes the hoisted push: the mono'd push body label may
		// be emitted, but nothing calls it.
		expect(code).not.toContain("List_string_push(&items");
		// The in-place sequence carries no temp home and no temp free.
		const seq = code.slice(at, code.indexOf("items.length += 1L", at) + 18);
		expect(seq).not.toContain("_param_");
		expect(seq).not.toContain("List_string_push");
	});

	test("aarch64 backend reserves, spills the slot, stores the pair", async () => {
		const input = `
func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var List<string> items = List<string>()
	items.push(fake_parse("x"))
	Console.write("\\{items.pop()}")
}
`;
		const parsed = parse_with_imports(input, { allow_user_raw: true });
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		// The mono'd push body also calls reserve (its own reserve(1)); the
		// in-place site is the occurrence whose sequence stores the result
		// pair through the spilled slot address.
		let at = -1;
		let seq = "";
		for (
			let pos = code.indexOf("bl List_string_reserve");
			pos >= 0;
			pos = code.indexOf("bl List_string_reserve", pos + 1)
		) {
			const window = code.slice(pos, pos + 420);
			if (window.includes("str x0, [x10]") && window.includes("str x1, [x10, #8]")) {
				at = pos;
				seq = window;
				break;
			}
		}
		expect(at).toBeGreaterThan(0);
		// The in-place sequence: slot address derived and spilled, the result
		// pair stored through it, the length bumped.
		expect(seq).toContain("str x11, [x29, #");
		expect(seq).not.toContain("bl List_string_push");
		expect(seq).not.toContain("_param_");
	});
});

describe("in-place push: checker gating", () => {
	test("a program with no push-of-call sites checks clean", async () => {
		const parsed = parse_with_imports(`
func main = () {
	var List<string> items = List<string>()
	items.push("x")
	const s = items.pop()
	Console.write(s)
}
`);
		expect(parsed.errors).toEqual([]);
	});
});
