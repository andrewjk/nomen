import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";

/**
 * Field-home marshalling (ASM_PLAN_2 tranche H follow-up slice — the
 * remaining field-read shuffles and the field-WRITE self push). The
 * receipt that named it: BigInt limb loops still pushed/popped the
 * receiver around every `self.len = …` write (`mov x0, x19; str x0,
 * [sp, #-16]!; …; ldr x0, [sp], #16`) and multi-hop reads (`o.inner.v`)
 * still built each hop through x0 with a caller-side shuffle. Both homes
 * already exist: a callee-saved param register survives the RHS build
 * (ABI + inline-expansion save/restore), and a chain of inline value-struct
 * hops is base + Σoffset — one load, no round-trip.
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

function fn_body(code: string, label: string): string {
	const start = code.indexOf(`${label}:`);
	expect(start).toBeGreaterThan(-1);
	const end = code.indexOf(".return_", start);
	return code.slice(start, end > start ? end : start + 3000);
}

const WRITE_SHAPE = `
import System

struct Counter {
  var int len
  pub func set_len = (ref self, int n) {
    self.len = n
  }
  pub func len_from_call = (ref self, Inner i) {
    self.len = i.doubled()
  }
  pub func #init = (self) {
    self.len = 0
  }
}

struct Inner {
  var int v
  pub func doubled = (self, out int) {
    return self.v * 2
  }
  pub func #init = (self, int v) {
    self.v = v
  }
}

pub func main = () {
  var Counter c = Counter()
  c.set_len(5)
  c.len_from_call(Inner(21))
  Console.write("\\{c.len}")
}
`;

test("scalar field write with a callee-saved receiver skips the push/pop", () => {
	const code = compile(WRITE_SHAPE);
	const body = fn_body(code, "Counter_set_len");
	// The store goes straight through the receiver's register.
	expect(body).toMatch(/str x2, \[x19, #\d+\]\n/);
	// No base push/pop pair around the RHS.
	expect(body).not.toMatch(/str x0, \[sp, #-16\]!\n[\s\S]*ldr x0, \[sp\], #16\n/);
});

test("field write with a call in the RHS stores after the call through the register", () => {
	const code = compile(WRITE_SHAPE);
	const body = fn_body(code, "Counter_len_from_call");
	const bl_at = body.indexOf("bl Inner_doubled");
	expect(bl_at).toBeGreaterThan(-1);
	const store_at = body.indexOf("str x2, [x19,");
	expect(store_at).toBeGreaterThan(bl_at);
	expect(body).not.toMatch(/str x0, \[sp, #-16\]!/);
});

const CHAIN_SHAPE = `
import System

struct Inner {
  var int v
  pub func #init = (self, int v) {
    self.v = v
  }
}

struct Mid {
  var Inner inner
  pub func #init = (self, int v) {
    self.inner = Inner(v)
  }
}

struct Outer {
  var Mid mid
  pub func #init = (self, int v) {
    self.mid = Mid(v)
  }
}

pub func scale = (Outer o, out int) {
  return o.mid.inner.v * 2
}

pub func main = () {
  var Outer o = Outer(21)
  Console.write("\\{scale(o)}")
}
`;

test("multi-hop chain operand loads direct from the receiver home", () => {
	const code = compile(CHAIN_SHAPE);
	const body = fn_body(code, "scale");
	// The 3-hop chain is ONE summed-offset load from the callee-saved param
	// register — no per-hop x0 builds and no `mov x1, x0` shuffle.
	expect(body).toMatch(/ldr x1, \[x1[0-9], #\d+\]\n/);
	expect(body).not.toMatch(/mov x1, x0\n/);
});

test("multi-hop chain behavioral: three nested value structs, both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
struct Inner {
  var int v
  pub func #init = (self, int v) {
    self.v = v
  }
}
struct Mid {
  var Inner inner
  pub func #init = (self, int v) {
    self.inner = Inner(v)
  }
}
struct Outer {
  var Mid mid
  pub func #init = (self, int v) {
    self.mid = Mid(v)
  }
}
var Outer o = Outer(7)
var int a = o.mid.inner.v
Console.write("\\{a}")
Console.write("\\{o.mid.inner.v * 2 + 1}")
`,
		"field_marshal_chain_read",
		"715",
	);
});

test("field-write behavioral: plain, call-RHS, and compound writes keep values", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// The call-RHS shape pins the deferred ordering: the RHS call runs and
	// completes before the store re-reads the receiver register; the
	// compound shape exercises the operator path beside it.
	await build_and_check_output(
		`
struct Counter {
  var int len
  pub func set_len = (ref self, int n) {
    self.len = n
  }
  pub func grow = (ref self, int n) {
    self.len = self.triple(n)
    self.len += 1
  }
  func triple = (self, int k, out int) {
    return k * 3
  }
  pub func #init = (self) {
    self.len = 0
  }
}
var Counter c = Counter()
c.set_len(5)
Console.write("\\{c.len}")
c.grow(4)
Console.write("\\{c.len}")
`,
		"field_marshal_deferred_write",
		"513",
	);
});

test("string-field write defers its base past the strdup/free dance", () => {
	const code = compile(`
import System

pub class Panel {
  var string title = ""
  pub func set_title = (ref self, string t) {
    self.title = t
  }
  pub func #init = (self) {}
}

pub func main = () {
  var Panel f = Panel()
  f.set_title("hello")
  Console.write("\\{f.title}")
}
`);
	const body = fn_body(code, "Panel_set_title");
	// The old value is freed THROUGH the receiver register and the new pair
	// stores through it — no base push/pop, no [sp, #16] reload of the base.
	expect(body).toMatch(/ldr x0, \[x19, #\d+\]\nbl _free\n/);
	expect(body).toMatch(/str x2, \[x19, #\d+\]\nstr x3, \[x19, #\d+\]\n/);
	expect(body).not.toMatch(/str x0, \[sp, #-16\]![\s\S]*ldr x0, \[sp\], #16\n/);
});

test("view-field write stores the pair through the receiver register", () => {
	const code = compile(`
import System

pub class Panel {
  view string text
  pub func set_text = (ref self, string doc) {
    if doc.length == 8 {
      self.text = doc.slice(1, 4)
    }
  }
  pub func #init = (self) {}
}

pub func main = () {
  var Panel f = Panel()
  f.set_text("document")
  Console.write("\\{f.text}")
}
`);
	const body = fn_body(code, "Panel_set_text");
	expect(body).toMatch(/str x2, \[x19, #\d+\]\nstr x3, \[x19, #\d+\]\n/);
	expect(body).not.toMatch(/str x0, \[sp, #-16\]![\s\S]*ldr x0, \[sp\], #16\n/);
});

test("string-field ownership behavioral: literal, heap, literal overwrites", async () => {
	// Each overwrite frees the displaced heap value exactly once (class
	// fields are always-heap): a mistake is an abort or an audit LEAK.
	// aarch64-only: the C backend has the documented method-string-field
	// assignment bug (test/method-string-field-gaps.test.ts) for this shape.
	const { default: check_output } = await import("./check_output");
	const { default: parse_with_imports } = await import("./parse_with_imports");
	const { load_system_fn_names, load_system_struct_names } = await import("./system_lib");
	const parsed = parse_with_imports(`
pub class Panel {
  var string title = ""
  pub func set_title = (ref self, string t) {
    self.title = t
  }
  pub func set_title_heap = (ref self) {
    self.title = 42.to_string()
  }
  pub func #init = (self) {}
}
var Panel f = Panel()
f.set_title("hello")
Console.write("\\{f.title}")
f.set_title_heap()
Console.write("\\{f.title}")
f.set_title("again")
Console.write("\\{f.title}")
`);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, {
		arch: "aarch64",
		audit: true,
		emit_mode: "user",
		system_struct_names: load_system_struct_names(),
	});
	await check_output("field_marshal_string_ownership", result, "hello42again", {
		arch: "aarch64",
		audit: true,
		system_lib: true,
		system_fn_names: load_system_fn_names(),
	});
});
