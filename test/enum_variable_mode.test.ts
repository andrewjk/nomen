import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
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

describe("enum variable mode: case types over generic enums (remainder 13(2))", () => {
	test("Option<int>.some: construct, match, == — audit clean", async () => {
		const input = `
import System

pub enum Option<T> {
	case none
	case some(T value)
}

pub func main = (Init init) {
	var Option<int>.some o = .some(4)
	var int total = 0
	match o {
		case .some(v) { total = v }
	}
	var Option<int>.none n = .none
	var Option<int> wide = .none
	wide = .some(total * 2)
	match wide {
		case .some(v) { total = v }
		case .none {}
	}
	Console.write("\\{total} \\{o == .some(4)} \\{n == .none}")
}
`;
		await build_and_check_output(input, "enum_gen_case_option_int", "8 true true", true);
	});

	test("Result<int, string>.ok with an mv string payload — audit clean", async () => {
		const input = `
import System

pub checked enum Result<T, E> {
	case ok(T value)
	case fail(E message)
}

func parse = (string raw, out Result<int, string>) {
	if raw == "bad" {
		return .fail("nope".copy())
	}
	return .ok(11)
}

pub func main = (Init init) {
	var Result<int, string>.ok ok = .ok(11)
	var int total = 0
	match ok {
		case .ok(v) { total = v }
	}
	// churn: fresh int payloads per construction — the audit proves each
	// displaced value is reclaimed exactly once
	ok = .ok(total * 2)
	match ok {
		case .ok(v) { Console.write("\\{v}") }
	}
	Console.write("\\{total}")
}
`;
		await build_and_check_output(input, "enum_gen_case_result_mv", "2211", true);
	});

	test("case-mono construction through the explicit access spelling", async () => {
		const input = `
import System

pub enum Option<T> {
	case none
	case some(T value)
}

pub func main = (Init init) {
	var Option<int>.some o = Option.some(41)
	var int v = 0
	match o {
		case .some(x) { v = x }
	}
	Console.write("\\{v + 1}")
}
`;
		await build_and_check_output(input, "enum_gen_case_access_spelling", "42", true);
	});

	test("the case mono over a mono keeps the base tag (C tag typedef)", () => {
		// `some` is declaration index 1 in the generic — the case mono's
		// single case sits at position 0 but must store the base's tag 1,
		// so the C tag typedef carries the explicit value.
		const input = `
import System

pub enum Option<T> {
	case none
	case some(T value)
}

pub func main = (Init init) {
	var Option<int>.some s = .some(4)
	Console.write("\\{s == .some(4)}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		expect(result.headers).toContain("Option_int__some_some = 1");
	});
});

describe("enum variable mode: base↔case conversions (remainder 13(3))", () => {
	test("case → base conversion: declaration and assignment — audit clean", async () => {
		// PERF_PLAN item 13(3), widening half: a case-mono value's layout
		// (tag + its payload) is a byte-prefix of the parent enum's, so the
		// conversion copies the case-size prefix into the base slot; the
		// displaced payload frees run tag-guarded on the parent layout.
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

func main_body = (out int) {
	var Res.ok r_ok = Res.ok(7)
	var Res r = Res.err("x".copy())
	var int t1 = 0
	match r {
		case .ok(c) { t1 = c }
		case .err {}
	}
	r = r_ok
	var int t2 = 0
	match r {
		case .ok(c) { t2 = c }
		case .err {}
	}
	Console.write("\\{t1} \\{t2}")
	return 0
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;
		await build_and_check_output(input, "enum_case_to_base_conv", "0 70", true);
	});

	test("an implicit base → case assignment stays a type error (the checked cast is the surface)", () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

func main_body = (out int) {
	var Res r = Res.ok(7)
	var Res.ok r_ok = r
	return 0
}

pub func main = (Init init) {
	Console.write("ok")
}
`;
		const parsed = parse_raw(input);
		const result = build(parsed.root, { arch: "c" });
		const errors = [...parsed.errors, ...(result.errors ?? [])];
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].message).toContain("Type mismatch");
	});

	test("checked cast `r as Res.ok` with the matching variant — audit clean", async () => {
		// PERF_PLAN item 13(3), the narrowing half: an EXPLICIT checked cast —
		// a runtime tag comparison plus panic on variant mismatch (the
		// `_or_panic` philosophy; there is no implicit base→case conversion).
		// COPY semantics: the result is an independent value, the source
		// keeps ownership. The cast rides the `as` machinery: the target
		// `Res.ok` is a real type (the case mono).
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

func main_body = (out int) {
	var Res r = Res.ok(7)
	var Res.ok narrow = r as Res.ok
	var int t = 0
	match narrow {
		case .ok(c) { t = c }
	}
	return t
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;
		await build_and_check_output(input, "enum_case_cast_narrow_ok", "7", true);
	});

	test("checked cast with a different variant panics with the message", async () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

func main_body = (out int) {
	var Res r = Res.err("boom".copy())
	var Res.ok narrow = r as Res.ok
	return 0
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: false });
			expect(result.errors ?? []).toEqual([]);
			let thrown: unknown;
			try {
				await check_output(`enum_case_cast_panic_${arch}`, result, "unreachable", {
					arch,
					audit: false,
				});
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeDefined();
			const err = thrown as { stdout?: string; stderr?: string; message?: string };
			expect(`${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`).toContain(
				"base to case conversion: the value carries a different variant",
			);
		}
	});

	test("widening cast `case_val as Res` — sound, no check — audit clean", async () => {
		const input = `
import System

mv enum Res {
	case err(string message)
	case ok(int count)
}

func main_body = (out int) {
	var Res.ok r_ok = Res.ok(5)
	var Res wide = r_ok as Res
	var int t = 0
	match wide {
		case .ok(c) { t = c * 10 }
		case .err {}
	}
	return t
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;
		await build_and_check_output(input, "enum_case_cast_widen", "50", true);
	});

	test("checked cast copies: reassigning the original leaves the result unaffected — audit clean", async () => {
		// Copy semantics receipt: the cast result deep-copies the payloads
		// (the `<Mono>_copy` story), so the displaced-payload free at the
		// original's reassignment can never strand the result — with a
		// shared-bytes lowering this run would free the result's payload
		// out from under it (the auditor reports the stale free).
		const input = `
import System

mv enum Note {
	case absent
	case text(string body)
}

func main_body = (out int) {
	var Note n = Note.text("first".copy())
	var Note.text t = n as Note.text
	n = Note.text("second".copy())
	var got = ""
	match t {
		case .text(b) { got = b.copy() }
	}
	match n {
		case .text(b) { got = got + "-" + b.copy() }
		case .absent {}
	}
	Console.write(got)
	return 0
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;
		await build_and_check_output(input, "enum_case_cast_copy_independence", "first-second", true);
	});

	test("checked cast on a non-copyable payload enum is rejected (use match)", () => {
		// A trait payload is an owned instance pointer the copy cannot
		// duplicate (enum_copy_is_deep's rejection — the same family the
		// containers refuse). The cast must refuse at check time with the
		// match guidance.
		const input = `
import System

trait Speaker {
	func speak = (self, out string)
}

struct Dog {
	func speak = (self, out string) { return "woof" }
}

mv enum Slot {
	case empty
	case held(Speaker who)
}

func main_body = (out int) {
	var Slot s = Slot.held(Dog())
	var Slot.held narrowed = s as Slot.held
	return 0
}

pub func main = (Init init) {
	Console.write("ok")
}
`;
		const parsed = parse_raw(input);
		const result = build(parsed.root, { arch: "c" });
		const errors = [...parsed.errors, ...(result.errors ?? [])];
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].message).toContain("use match");
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

	test("case type on a generic enum resolves through its mono", () => {
		// PERF_PLAN remainder 13(2): `Option<int>.some` — the generic mono
		// (`Option_int`) materializes first, then the case mono over it
		// (`Option_int__some`), whose single case carries the ORIGINAL
		// declaration index as its tag.
		const input = `
import System

pub enum Option<T> {
	case none
	case some(T value)
}

pub func main = (Init init) {
	var Option<int>.some o = Option.some(1)
	Console.write("\\{o == .some(1)}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
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
