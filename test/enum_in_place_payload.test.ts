import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

// The in-place construction guarantee, enum-payload tranche (PERF_PLAN
// item 7): `Result.ok(parse(line))` constructs the producing call straight
// into the payload slot — the C backend calls an `_init_take` variant that
// claims the produced buffer (no strdup, no hoisted `_param_N` temp, no
// temp free); the aarch64 backend stores the produced (ptr, len) pair raw
// (heap-gated: a borrow/rodata pair falls back to the strdup'd owned copy)
// or presets the sret destination to the payload's frame address. The
// unstamped shapes (bare locals, `mv` donors, literals, method-call
// arguments) keep the hoisted lowering verbatim.

describe("enum in-place payload: runtime", () => {
	test("string payload from a direct call reads back", async () => {
		const input = `
import System

mv enum Res {
	case ok(string text)
	case err(int code)
}

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Res r = Res.ok(fake_parse("x"))
	match r {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
}
`;
		await build_and_check_output(input, "enum_inplace_string_readback", "x", true);
	});

	test("shorthand spelling takes the same lowering", async () => {
		const input = `
import System

mv enum Res {
	case ok(string text)
	case err(int code)
}

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Res r = .ok(fake_parse("y"))
	match r {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
}
`;
		await build_and_check_output(input, "enum_inplace_shorthand_readback", "y", true);
	});

	test("a borrow-pair producer falls back to the owned copy", async () => {
		const input = `
import System

mv enum Res {
	case ok(string text)
	case err(int code)
}

func lit = (int i, out string) {
	return "abc"
}

pub func main = (Init init) {
	var Res r = Res.ok(lit(7))
	match r {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
	var Res r2 = Res.ok("xyz".copy())
	match r2 {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
}
`;
		// The literal-returning producer hands back rodata — the raw store
		// must not claim it (the payload free would free foreign storage);
		// the strdup'd owned copy is the fallback. An owned method-call
		// result at the same site stores raw.
		await build_and_check_output(input, "enum_inplace_borrow_fallback", "abcxyz", true);
	});

	test("value-struct payload from a ctor and from a function", async () => {
		const input = `
import System

mv struct Rec {
	var int a
	var int b
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

func make_rec = (int k, out Rec) {
	return Rec(k, k * 2)
}

pub func main = (Init init) {
	var RecRes r = RecRes.found(Rec(3, 4))
	match r {
		case .found(rec) -> Console.write("\\{rec.a}\\{rec.b}")
		case .miss -> Console.write("miss")
	}
	var RecRes r2 = RecRes.found(make_rec(5))
	match r2 {
		case .found(rec) -> Console.write("\\{rec.a}\\{rec.b}")
		case .miss -> Console.write("miss")
	}
}
`;
		// (A struct payload with a STRING field hits a pre-existing
		// ownership gap — the enum teardown does not free struct payloads'
		// fields — recorded in FOLLOWUP.md; this test pins the in-place
		// construction on the int-only payload.)
		await build_and_check_output(input, "enum_inplace_struct_payload", "34510", true);
	});

	test("mixed payload lists: call + scalar, construction in a loop", async () => {
		const input = `
import System

mv enum Pair {
	case pair(string text, int n)
}

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var acc = 0
	var i = 0
	while i < 3 {
		var Pair p = Pair.pair(fake_parse("\\{i}"), i)
		match p {
			case .pair(t, n) { acc = acc + t.length + n }
		}
		i += 1
	}
	Console.write("\\{acc}")
}
`;
		// (1+0) + (1+1) + (1+2) = 6; every construction claims its produced
		// buffer and frees it at the local's scope exit (audit on).
		await build_and_check_output(input, "enum_inplace_mixed_payloads", "6", true);
	});

	test("the whole-site rule: a literal second string payload keeps the hoisted lowering", async () => {
		const input = `
import System

mv enum Two {
	case both(string a, string b)
}

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Two t = Two.both(fake_parse("x"), "lit")
	match t {
		case .both(a, b) -> Console.write("\\{a}\\{b}")
	}
}
`;
		// The C take-variant claims EVERY string argument — a site with any
		// non-call string argument must keep `_init` (strdup) so nothing is
		// double-owned. Correctness of the unstamped lowering is the assert.
		await build_and_check_output(input, "enum_inplace_whole_site_rule", "xlit", true);
	});

	test("construction in return and argument positions", async () => {
		const input = `
import System

mv enum Res {
	case ok(string text)
	case err(int code)
}

func fake_parse = (string line, out string) {
	return line.copy()
}

func produce = (out Res) {
	return Res.ok(fake_parse("ret"))
}

func consume = (Res r, out int) {
	match r {
		case .ok(t) { return t.length }
		case .err(c) { return c }
	}
	return 0
}

pub func main = (Init init) {
	var Res r = produce()
	match r {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
	var int n = consume(Res.ok(fake_parse("abcd")), )
	Console.write("\\{n}")
}
`;
		// The sret window is active while the payload call builds inside a
		// returned/argument construction; the owning scopes balance (audit).
		await build_and_check_output(input, "enum_inplace_positions", "ret4", true);
	});
});

describe("enum in-place payload: emitted code", () => {
	test("C backend calls the take variant; unstamped sites keep _init", async () => {
		const input = `
import System

mv enum Res {
	case ok(string text)
	case err(int code)
}

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Res r = Res.ok(fake_parse("x"))
	match r {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
	var Res r2 = Res.ok("lit")
	match r2 {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		// The take variant exists and is what the stamped site calls.
		expect(code).toContain("Res Res_ok_init_take(nomen_string text)");
		expect(code).toContain("Res r = Res_ok_init_take(fake_parse(");
		// Its body assigns the payload raw — no strdup.
		const take_at = code.indexOf("Res_ok_init_take(nomen_string text)");
		const take_body = code.slice(take_at, code.indexOf("}", take_at));
		expect(take_body).not.toContain("strdup");
		// The unstamped site (a literal argument) keeps the owning copy.
		expect(code).toContain("Res r2 = Res_ok_init(");
		// The stamped construction carries no hoisted temp home.
		const site_at = code.indexOf("Res_ok_init_take(fake_parse(");
		const site = code.slice(site_at, site_at + 80);
		expect(site).not.toContain("_param_");
	});

	test("aarch64 backend stores the produced pair raw", async () => {
		const input = `
import System

mv enum Res {
	case ok(string text)
	case err(int code)
}

func fake_parse = (string line, out string) {
	return line.copy()
}

pub func main = (Init init) {
	var Res r = Res.ok(fake_parse("x"))
	match r {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		const main_at = code.indexOf("_main:");
		const body = code.slice(main_at);
		const call_at = body.indexOf("bl fake_parse");
		expect(call_at).toBeGreaterThan(0);
		// The produced (ptr, len) pair lands straight in the payload slot —
		// no strdup between the call and the pair store, no hoisted temp.
		const seq = body.slice(call_at, call_at + 120);
		expect(seq).toContain("str x0, [x29, #");
		expect(seq).toContain("str x1, [x29, #");
		expect(seq).not.toContain("bl _strdup");
		expect(seq).not.toContain("_param_");
	});

	test("aarch64 backend presets the sret destination to the payload slot", async () => {
		const input = `
import System

mv struct Rec {
	var int a
	var int b
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

func make_rec = (int k, out Rec) {
	return Rec(k, k)
}

pub func main = (Init init) {
	var RecRes r = RecRes.found(make_rec(3))
	match r {
		case .found(rec) -> Console.write("\\{rec.a}")
		case .miss -> Console.write("miss")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		const main_at = code.indexOf("_main:");
		const body = code.slice(main_at);
		const call_at = body.indexOf("bl make_rec");
		expect(call_at).toBeGreaterThan(0);
		// The payload's frame address is spilled and preset as the sret
		// destination before the call — the callee constructs into the
		// payload slot, so no struct copy follows the call.
		const seq = body.slice(call_at - 120, call_at + 40);
		expect(seq).toContain("str x9, [x29, #");
		expect(seq).toMatch(/mov x8, x[0-9]+/);
		const after = body.slice(call_at + 12, call_at + 260);
		expect(after).not.toContain("bl make_rec");
	});
});

describe("enum in-place payload: checker gating", () => {
	test("method-call argument keeps the hoisted lowering", async () => {
		const input = `
import System

mv enum Res {
	case ok(string text)
	case err(int code)
}

pub func main = (Init init) {
	var Res r = Res.ok("x".copy())
	match r {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("err")
	}
}
`;
		// The tranche stamps direct calls only (the same exclusion the
		// in-place push stamps carry); the hoisted path stays correct.
		await build_and_check_output(input, "enum_inplace_method_excluded", "x", true);
	});

	test("scalar payload from a call keeps the ordinary store", async () => {
		const input = `
import System

mv enum Res {
	case ok(string text)
	case err(int code)
}

func fake_int = (int k, out int) {
	return k * 2
}

pub func main = (Init init) {
	var Res r = Res.err(fake_int(21))
	match r {
		case .ok(t) -> Console.write(t)
		case .err(c) -> Console.write("\\{c}")
	}
}
`;
		// Scalars store their width straight from the producing call's
		// register — no temp exists to elide, nothing changes.
		await build_and_check_output(input, "enum_inplace_scalar_excluded", "42", true);
	});
});
