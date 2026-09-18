// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("declare/assign/eval statements emit through the NIR seam byte-identically", () => {
	// Tranche 4: the remaining statement kinds' value positions. Declares of
	// every initializer shape (literal, op, cast, grouped, call, view-free
	// struct ctor, heap array literal with RUNTIME elements riding the NIR
	// element facts), assignments (plain, compound scalar/field/float, string
	// re-concat, indexed store), and bare-expression statements (free call,
	// method call, nursery-free). Parsed raw so the struct can live at module
	// scope (a nested struct declaration would force the AST fallback).
	expect_byte_identical(
		`
import System

struct Counter {
    var int count
    var string label
}

func bump = (int by, out int) {
    return by + 1
}

pub func main = () {
    var int base = 10
    var int scaled = base * 3
    var int grp = (base + 2)
    var uint64 wide = base as uint64
    var float ratio = 0.5
    var string greeting = "hi " + "there"
    var Counter c = Counter(0, "none")
    var int[3] nums = [7, 8, 5]
    c.count = base
    c.count += 4
    c.label = "set"
    base = bump(base)
    base += 2
    ratio += 0.25
    greeting = greeting + "!"
    nums.set(0, 9)
    nums.set(1, base)
    bump(base)
    Console.write("\\{base} \\{ratio} \\{greeting} \\{c.count} \\{c.label} \\{nums.at(0)} \\{nums.at(1)}")
}
`,
		true,
	);
});
