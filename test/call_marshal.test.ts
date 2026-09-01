import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";

/**
 * Call-site operand-home marshalling (ASM_PLAN_2 tranche H — the
 * cross-statement-temporaries slice). The receipt that named it: the
 * BigInt limb loops still marshalled every call through anonymous
 * round-trips — the receiver pushed/popped across argument evaluation
 * (`str x0, [sp, #-16]!` … `ldr x0, [sp], #16`) and every scalar argument
 * built through x0 then shuffled into its register (`mov x0, #0; mov
 * x1, x0`). The tranche gives operands their homes: a callee-saved-holding
 * receiver defers its `mov x0, <reg>` to after argument evaluation, and
 * leaf scalar arguments materialize directly into their slot registers
 * (named leaves gated on call-free siblings — deferral moves their read
 * past the siblings' evaluation).
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const METHOD_SHAPE = `
import System

struct Box {
  var int v
  pub func scaled = (self, int k, out int) {
    return self.v * k
  }
  pub func twice_scaled = (self, out int) {
    return self.scaled(5) * 2
  }
  pub func #init = (self, int v) {
    self.v = v
  }
}

pub func main = () {
  var Box b = Box(3)
  Console.write("\\{b.twice_scaled()}")
}
`;

test("method call marshals a literal arg directly into its register", () => {
	const code = compile(METHOD_SHAPE);
	const body = code.slice(
		code.indexOf("Box_twice_scaled:"),
		code.indexOf(".return_Box_twice_scaled:"),
	);
	// The `mov x0, #5; mov x1, x0` shuffle is gone: the literal lands in x1.
	expect(body).toMatch(/mov x1, #5\n/);
	expect(body).not.toMatch(/mov x0, #5\nmov x1, x0/);
});

test("receiver in a callee-saved register defers its self load past the args", () => {
	const code = compile(METHOD_SHAPE);
	const body = code.slice(
		code.indexOf("Box_twice_scaled:"),
		code.indexOf(".return_Box_twice_scaled:"),
	);
	// `self` is a param in a callee-saved register: no push/pop around the
	// argument evaluation, and `mov x0, x19` comes AFTER the arg materializes.
	expect(body).not.toMatch(/str x0, \[sp, #-16\]!\nmov x1, #5/);
	const arg_at = body.indexOf("mov x1, #5");
	const self_at = body.slice(arg_at).search(/mov x0, x19\n/);
	expect(self_at).toBeGreaterThan(-1);
});

test("a func-typed leaf arg does not clobber already-parked registers", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// The deferred materialization parks registers in descending slot order:
	// the func ref's `adr x0, <label>` fallback runs BEFORE `mov x0, #4`.
	await build_and_check_output(
		`
func multiply = (int a, out int) => a * 5
func apply = (int num, func (int, out int) f, out int) => f(num)
Console.write("\\{apply(4, multiply)}")
`,
		"call_marshal_func_arg",
		"20",
	);
});

test("slot var args read their slot directly (no x0 round-trip)", () => {
	const code = compile(`
import System

pub func main = () {
	var int k = 41
	Console.write("\\{k + 1}")
}
`);
	const main = code.slice(code.indexOf("_main:"), code.indexOf("_string_interpolate"));
	// k loads straight into the operand register.
	expect(main).toMatch(/ldr x[0-9]+, \[x29, #[0-9]+\]\n/);
	expect(main).not.toMatch(/ldr x0, \[x29, #[0-9]+\]\nmov x1, x0/);
});

test("call siblings hoisted by the checker keep exact semantics", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// The checker extracts call arguments into `const _param_N` temps before
	// emission, so `t.bump(cell)` RUNS first (cell: 1 → 2, returns 2) and
	// sub's leaf arg then reads the post-call value — identically with and
	// without deferred leaf materialization. This pins that contract:
	// sub(2, 2) = 22 on both backends.
	//
	// (The emitter's call-free sibling gate stays as defense-in-depth for
	// any future shape the checker does not hoist. Heap-backed Buffer cells
	// stand in for a ref local — the C backend's hoisted `ref`-arg temp has
	// a separate pre-existing gap, recorded in FOLLOWUP.md.)
	await build_and_check_output(
		`
struct Calc {
  pub func sub = (self, int a, int b, out int) {
    return a * 10 + b
  }
  pub func #init = (self) {}
}

struct Taker {
  pub func bump = (self, ref Buffer<int> cell, out int) {
    if cell.cap > 0 {
      cell.store_int(0, cell.load_int(0) + 1)
      return cell.load_int(0)
    }
    return 0
  }
  pub func #init = (self) {}
}

var Calc c = Calc()
var Taker t = Taker()
var Buffer<int> cell = Buffer<int>()
cell.alloc_int(1)
cell.store_int(0, 1)
Console.write("\\{c.sub(t.bump(ref cell), cell.load_int(0))}")
`,
		"call_marshal_hoisted_sibling_order",
		"22",
	);
});

test("promoted d-register floats still read their register as operands", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// The slot fast path must never fire for a promoted variable: its home
	// is the d-register; the sync slot holds the stale pre-loop value.
	await build_and_check_output(
		`
var float acc = 0.5
var int i = 0
while i < 3; i += 1 {
	acc = acc + acc
}
Console.write("\\{acc}")
`,
		"call_marshal_promoted_float_operand",
		"4.000000",
	);
});
