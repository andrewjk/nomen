import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Variable-mode enums (PERF_PLAN item 13, GOOSE #6): a case-qualified type
// spelling `Enum.case` (`Res.ok`) names the variable-mode form of the enum —
// a value that is one specific case, stored at that case's size (tag word +
// the case payload, word-rounded) instead of tag + the LARGEST case payload.
// The freeze-at-construction constraint is enforced by the type system: a
// `Res.ok` slot can only hold `.ok` values (nothing else types as `Res_ok`),
// so it can never change variant — the safety condition MEMORY.md's
// tagged-union note leans on. The type materializes as a single-case mono
// enum (`Res_ok`) whose tags match the base enum's case indices, so all of
// the enum machinery (match, ==, containers, ownership) applies verbatim.

describe("enum variable mode: runtime", () => {
	test("int payload round-trips through a case-typed local", async () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

pub func main = (Init init) {
	var Res.ok r = Res.ok(42)
	var total = 0
	match r {
		case .ok(count) { total = count }
	}
	Console.write("total=" + total.to_string())
}
`;
		await build_and_check_output(input, "enum_vm_int_roundtrip", "total=42", true);
	});

	test("shorthand construction spelling takes the same lowering", async () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

pub func main = (Init init) {
	var Res.ok r = .ok(7)
	match r {
		case .ok(c) { Console.write(c.to_string()) }
	}
}
`;
		await build_and_check_output(input, "enum_vm_shorthand", "7", true);
	});

	test("string payload: construct, match, reassign same case — audit clean", async () => {
		const input = `
import System

mv enum Res {
	case err(int code)
	case ok(string text)
}

pub func main = (Init init) {
	var Res.ok r = Res.ok("first".copy())
	r = Res.ok("second".copy())
	match r {
		case .ok(t) { Console.write(t) }
	}
}
`;
		await build_and_check_output(input, "enum_vm_string_replace", "second", true);
	});

	test("case-typed List: push, read sweep, pop", async () => {
		const input = `
import System

mv enum Item {
	case missing
	case small(int id)
	case big(int id, string tag, int extra)
}

pub func main = (Init init) {
	var List<Item.small> l = List()
	var i = 0
	while i < 4; i += 1 {
		l.push(Item.small(i * 3))
	}
	var sum = 0
	i = 0
	while i < l.length; i += 1 {
		match l.at(i) {
			case .small(id) { sum = sum + id }
		}
	}
	while l.length > 0 {
		match l.pop() {
			case .small(id) { sum = sum - id }
		}
	}
	Console.write("sum=" + sum.to_string())
}
`;
		await build_and_check_output(input, "enum_vm_list", "sum=0", true);
	});

	test("case-typed List of string payloads: copy independence — audit clean", async () => {
		const input = `
import System

mv enum Note {
	case absent
	case text(string body)
}

pub func main = (Init init) {
	var List<Note.text> l = List()
	l.push(Note.text("alpha".copy()))
	l.push(Note.text("beta".copy()))
	var Note.text n = l.at_or_panic(1)
	n = Note.text("gamma".copy())
	var got = ""
	match l.at_or_panic(0) {
		case .text(b) { got = b.copy() }
	}
	Console.write(got)
	Console.write("-")
	match l.at_or_panic(1) {
		case .text(b) { got = b.copy() }
	}
	Console.write(got)
}
`;
		await build_and_check_output(input, "enum_vm_list_strings", "alpha-beta", true);
	});

	test("zero-payload case mono is a single tag word", async () => {
		const input = `
import System

enum Shape {
	case point
	case circle(int radius)
	case rect(int w, int h)
}

pub func main = (Init init) {
	var Shape.point p = Shape.point
	var Shape.circle c = Shape.circle(9)
	var area = 0
	match p {
		case .point { area = 1 }
	}
	match c {
		case .circle(r) { area = area + r * r }
	}
	Console.write("area=" + area.to_string())
}
`;
		await build_and_check_output(input, "enum_vm_zero_payload", "area=82", true);
	});

	test("== on two case-mono values", async () => {
		const input = `
import System

enum Flag {
	case off
	case on(bool loud)
}

pub func main = (Init init) {
	var Flag.on a = Flag.on(true)
	var Flag.on b = Flag.on(false)
	if a == b {
		Console.write("eq")
	} else {
		Console.write("neq")
	}
	var Flag.off x = Flag.off
	var Flag.off y = Flag.off
	if x == y {
		Console.write("-eq")
	}
}
`;
		await build_and_check_output(input, "enum_vm_eq", "eq-eq", true);
	});

	test("struct field of case-mono type", async () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

struct Holder {
	var Res.ok r
	var int stamp = 0
}

pub func main = (Init init) {
	var Holder h = Holder(Res.ok(11))
	h.stamp = 3
	var total = 0
	match h.r {
		case .ok(c) { total = c * h.stamp }
	}
	Console.write("total=" + total.to_string())
}
`;
		await build_and_check_output(input, "enum_vm_struct_field", "total=33", true);
	});

	test("case-mono param and return", async () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

func double_it = (Res.ok r, out Res.ok) {
	var Res.ok out_val = Res.ok(0)
	match r {
		case .ok(c) { out_val = Res.ok(c * 2) }
	}
	return out_val
}

pub func main = (Init init) {
	var Res.ok r = Res.ok(21)
	var Res.ok d = double_it(r)
	match d {
		case .ok(c) { Console.write(c.to_string()) }
	}
}
`;
		await build_and_check_output(input, "enum_vm_param_return", "42", true);
	});
});

describe("enum variable mode: sizes", () => {
	test("the mono's slot is variant-sized (aarch64 frame allocation)", () => {
		const body = (annotation: string) => `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

pub func main = (Init init) {
	var ${annotation} r = Res.ok(2)
	var t = 0
	if r == Res.ok(2) { t = 1 }
	Console.write(t.to_string())
}
`;
		// Same program, base vs case annotation: the case local's frame slot
		// is tag + int (16) where the base local is tag + max payload (24) —
		// the enum frame shrinks by 16 (local + construction temp) and the
		// value copy shrinks from three words to two.
		const base_parsed = parse_raw(body("Res"));
		expect(base_parsed.errors).toEqual([]);
		const base_code = build(base_parsed.root, { arch: "aarch64" }).code;
		const mono_parsed = parse_raw(body("Res.ok"));
		expect(mono_parsed.errors).toEqual([]);
		const mono_code = build(mono_parsed.root, { arch: "aarch64" }).code;
		expect(base_code).toContain("sub sp, sp, #112\n");
		expect(mono_code).toContain("sub sp, sp, #96\n");
		expect(mono_code).not.toContain("sub sp, sp, #112\n");
		// The base copies tag + 2 payload words; the mono copies tag + 1.
		expect(base_code).toContain("ldr x3, [x0, #8]\nstr x3, [x1, #8]\nldr x3, [x0, #16]\n");
		expect(mono_code).toContain("ldr x3, [x0, #8]\nstr x3, [x1, #8]\nmov x0, #0\n");
		expect(mono_code).not.toContain("ldr x3, [x0, #16]\n");
	});

	test("container stride follows the case size (C sizeof)", () => {
		const input = `
import System

mv enum Item {
	case missing
	case small(int id)
	case big(int id, string tag, int extra)
}

pub func main = (Init init) {
	var List<Item.small> l = List()
	l.push(Item.small(1))
	Console.write(l.length.to_string())
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		// The List<Item.small> mono strides at 16 (tag + int), not the base
		// enum's 32 (tag + {int, string, int} max payload). The mono's tag
		// constant carries the ORIGINAL case index (1).
		expect(result.headers).toContain("typedef enum { Item__small_small = 1 } Item__small_tag;");
		expect(result.headers).toContain("} Item__small;");
		expect(result.code).toContain("sizeof(Item__small)");
		expect(result.code).not.toContain("sizeof(Item)");
	});
});

describe("enum variable mode: errors", () => {
	test("a different case cannot construct into a case-typed slot", () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

func main_body = (out int) {
	var Res.ok r = Res.err("boom")
	return 0
}

pub func main = (Init init) {
	Console.write("ok")
}
`;
		const parsed = parse_raw(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const errors = [...parsed.errors, ...(result.errors ?? [])];
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].message).toContain("Type mismatch");
	});

	test("an unknown case is rejected", () => {
		const input = `
import System

mv enum Res {
	case ok(int count)
}

func main_body = (out int) {
	var Res.nope r = Res.ok(1)
	return 0
}

pub func main = (Init init) {
	Console.write("ok")
}
`;
		const parsed = parse_raw(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const errors = [...parsed.errors, ...(result.errors ?? [])];
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].message).toContain("has no case 'nope'");
	});

	test("a base-typed value cannot flow into a case-typed slot", () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

func make = (out Res) {
	return Res.ok(5)
}

func main_body = (out int) {
	var Res base = make()
	var Res.ok r = base
	return 0
}

pub func main = (Init init) {
	Console.write("ok")
}
`;
		const parsed = parse_raw(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const errors = [...parsed.errors, ...(result.errors ?? [])];
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].message).toContain("Type mismatch");
	});

	test("case type on a generic enum is rejected at parse", () => {
		const input = `
pub func main = (Init init) {
	var Option<int>.some o = Option.some(1)
	Console.write("x")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("not supported yet");
	});

	test("a case-mono name collision with a declared type is rejected", () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

struct Res__ok {
	var int x = 0
}

func main_body = (out int) {
	var Res.ok r = Res.ok(1)
	return 0
}

pub func main = (Init init) {
	Console.write("ok")
}
`;
		const parsed = parse_raw(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const errors = [...parsed.errors, ...(result.errors ?? [])];
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].message).toContain("collides");
	});
});
