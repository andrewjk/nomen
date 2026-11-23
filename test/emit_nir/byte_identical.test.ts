import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

// --- address_position_struct_rhs.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("address-position struct RHS emits through the NIR seam byte-identically", () => {
	// Tranche 5: get_source_address with a non-name RHS is a VALUE emission in
	// address position (a struct-typed RHS builds to an ADDRESS in x0) — it
	// now descends the expression seam; plain names keep their slot/param-reg
	// resolution on the AST path.
	expect_byte_identical(`
struct Pt {
  var int x
  var int y
}
func mk = (int a, out Pt) {
  return Pt(a, a + 1)
}
func run_addr = (out int) {
  var Pt p = Pt(0, 0)
  p = mk(3)
  return p.x + p.y
}
Console.write("\\{run_addr()}")
`);
});

// --- array_literal_returns.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("array literal returns ride the NIR element facts byte-identically", () => {
	expect_byte_identical(`
func triple = (out int[]) {
    return [4, 5, 6]
}
func total = (out int) {
    var int sum = 0
    for v of triple() {
        sum = sum + v
    }
    return sum
}
Console.write("\\{total()}")
`);
});

// --- assignment_swaps.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("assignment swaps marshal through the NIR seam byte-identically", () => {
	// Tranche 5: the swap replacement (`a = b swap <rep>`) is a value
	// emission inside the swap marshalling, for both variable-RHS and
	// field-RHS swap shapes.
	expect_byte_identical(`
mv struct Box {
  var int value
}
mv struct Holder {
  mv Box content
}
func run_swap_var = (out int) {
  var Box a = Box(1)
  var Box b = Box(2)
  a = b swap Box(7)
  return a.value * 10 + b.value
}
func run_swap_field = (out int) {
  var Holder h1 = Holder(mv Box(1))
  var Holder h2 = Holder(mv Box(2))
  h1.content = h2.content swap Box(99)
  return h1.content.value * 100 + h2.content.value
}
Console.write("\\{run_swap_var()} \\{run_swap_field()}")
`);
});

// --- async_nursery_body.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("async nursery body dispatches NIR-natively (nested flow inside the cursor)", () => {
	// The async_block dispatch arm hands build_async_block_node the lowered
	// body, whose block installs its own cursor — an if inside the nursery
	// now dispatches NIR-natively instead of riding the AST walk.
	expect_byte_identical(`
func probe = (int v, out int) {
    return v + 1
}
func nursery_flow = (out int) {
    var int total = 0
    async(timeout: 2000) {
        Thread(probe(1)).start()
        if total == 0 {
            total = total + 40
        }
    }
    return total
}
Console.write("\\{nursery_flow()}")
`);
});

// --- bare_nursery_spawn.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("bare nursery-spawn statements stay fire-and-forget through the NIR eval seam", () => {
	// The delegated path stamps is_statement on a nursery-spawn statement via
	// build_node's with_semicolon side effect; the eval arm must replicate it
	// or the spawn would emit a joined (waited) task instead of fire-and-forget
	// — an observable output difference this byte-identity test would catch.
	expect_byte_identical(`
func work = (uint64 id) {
    Console.write_line("ok")
}
async nursery {
    nursery.start(Thread(work(1)))
    var t = nursery.start(Thread(work(2)))
    t.wait()
}
`);
});

// --- declaration_swaps.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("declaration swaps marshal through the NIR seam byte-identically", () => {
	// Tranche 5: `var Pt c = mv w.pt swap <rep>` — the value-struct
	// declaration path's swap replacement rides the seam too.
	expect_byte_identical(`
struct Pt {
  var int x
  var int y
}
struct Wrap {
  var Pt pt
}
func run_decl = (out int) {
  var Wrap w = Wrap(Pt(4, 4))
  var Pt c = mv w.pt swap Pt(5, 5)
  return c.x * 10 + w.pt.x
}
Console.write("\\{run_decl()}")
`);
});

// --- float_string_returns.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("float and string returns keep byte-identity through the expression seam", () => {
	expect_byte_identical(`
func half_of = (float v, out float) {
    return v / 2.0
}
func scale = (float x, out float) {
    if x > 1.0 {
        return x * 2.5
    }
    return half_of(x) + 0.5
}
func greet = (string who, out string) {
    if who == "world" {
        return "hi " + who
    }
    return who
}
Console.write("\\{scale(2.0)} \\{scale(0.5)} \\{greet("world")} \\{greet("bob")}")
`);
});

// --- flow_nesting.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("flow-shaped nesting (match in for, for in match) emits NIR-natively", () => {
	expect_byte_identical(`
func nested_flow = (int n, out int) {
    var int acc = 0
    for i of 0 .. n {
        match i % 3 {
            case 0 -> acc = acc + 10
            case 1 {
                var int j = 0
                while j < i {
                    acc = acc + 1
                    j = j + 1
                }
            }
    } else -> acc = acc + 1
        }
    return acc
}
Console.write("\\{nested_flow(6)}")
`);
});

// --- for_array_iteration.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("array-iteration for loops emit NIR-natively byte-identically", () => {
	expect_byte_identical(`
func total = (out int) {
    var int[] nums = [3, 1, 2]
    var int sum = 0
    for n of nums {
        if n > 1 {
            sum = sum + n
        }
    }
    return sum
}
Console.write("\\{total()}")
`);
});

// --- for_loops.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("for loops emit NIR-natively (range path, nested ifs NIR-driven)", () => {
	expect_byte_identical(`
func count_even = (int n, out int) {
    var int c = 0
    for i of 0 .. n {
        if i % 2 == 0 {
            c = c + 1
        }
    }
    return c
}
Console.write("\\{count_even(10)}")
`);
});

// --- for_ref_writeback.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("for ref of array (writeback path) emits NIR-natively byte-identically", () => {
	expect_byte_identical(`
func zeroed = (out int) {
    var int[] nums = [7, 8, 9]
    for ref n of nums {
        n = n - 1
    }
    var int sum = 0
    for n of nums {
        sum = sum + n
    }
    return sum
}
Console.write("\\{zeroed()}")
`);
});

// --- if_else_chains.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("if/else chains are byte-identical through the NIR emission path", () => {
	expect_byte_identical(`
var int score = 71
var int grade = 0
if score >= 90 {
    grade = 4
} else {
    grade = 1
}
if score > 100 {
    grade = 9
}
if grade == 1 {
    grade = grade + 2
}
Console.write("\\{grade}")
`);
});

// --- match_arms.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("match arms emit NIR-natively byte-identically", () => {
	expect_byte_identical(`
func describe = (int x, out string) {
    var string label = "other"
    match x {
        case 1 -> label = "one"
        case 2 -> label = "two"
    } else -> label = "many"
    return label
}
Console.write("\\{describe(1)} \\{describe(5)}")
`);
});

// --- nested_functions.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("nested functions delegate and install their own NIR ctx", () => {
	expect_byte_identical(`
func twice = (int v, out int) {
    return v * 2
}
func apply_twice = (int v, out int) {
    return twice(twice(v))
}
Console.write("\\{apply_twice(3)}")
`);
});

// --- nested_while.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("nested while loops keep byte-identical promotion interplay", () => {
	expect_byte_identical(`
func mul_table_sum = (int n, out int) {
    var int total = 0
    var int i = 0
    while i < n {
        var int j = 0
        while j < n {
            total = total + i * j
            j = j + 1
        }
        i = i + 1
    }
    return total
}
Console.write("\\{mul_table_sum(4)}")
`);
});

// --- raw_aarch64_statements.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("raw aarch64 statements delegate byte-identically", () => {
	expect_byte_identical(
		`
var int x = 1
#if META.arch == "aarch64" {
	#raw {
		ldr x0, =5
	}
}
Console.write("\\{x}")
`,
		false,
		true,
	);
});

// --- return_shapes.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("return values of every expression shape emit through the NIR seam", () => {
	expect_byte_identical(`
func helper = (int v, out int) {
    return v * 2
}
func shape_test = (int n, out int) {
    if n == 0 {
        return 0
    }
    if n == 1 {
        return (n + 2) * 3
    }
    if n == 2 {
        return (n * n) as int
    }
    if n == 3 {
        return helper(n) + helper(n + 1)
    }
    return 0 - n
}
Console.write("\\{shape_test(0)} \\{shape_test(1)} \\{shape_test(2)} \\{shape_test(3)} \\{shape_test(9)}")
`);
});

// --- returns_nested_flow.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("returns from nested flow arms emit NIR-natively", () => {
	expect_byte_identical(`
func first_hit = (int limit, out int) {
    var int i = 0
    while i < limit {
        if i * i > 20 {
            return i
        }
        i = i + 1
    }
    return 0
}
func scan_up = (int n, out int) {
    for i of 0 .. n {
        if i > 3 {
            return i * 10
        }
    }
    return 0
}
Console.write("\\{first_hit(10)} \\{scan_up(2)} \\{scan_up(9)}")
`);
});

// --- switch_chains.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("switch chains emit NIR-natively byte-identically", () => {
	expect_byte_identical(`
func size_of = (int x, out string) {
    var string s = "small"
    switch {
        case x > 100 -> s = "big"
        case x > 10 -> s = "medium"
    } else -> s = "small"
    return s
}
Console.write("\\{size_of(500)} \\{size_of(3)}")
`);
});

// --- value_position_flow.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("value-position match/if/switch join through the seam byte-identically", () => {
	// The Container.nm pattern: match/if/switch as a DECLARATION initializer.
	// Each lowers to a `flow` expr; the declaration's init site descends the
	// seam, whose flow arm routes the original node to the join-slot
	// builders (status.return_assign stores each arm's value).
	expect_byte_identical(`
func classify = (int v, out int) {
    var int kind = match v {
        case 0 -> 100
        case 1 -> 200
    } else -> 300
    var int bump = if kind > 150 -> 5
                   else -> 1
    var int wrap = switch {
        case kind == 100 -> 7
    } else -> 9
    return kind + bump + wrap
}
Console.write("\\{classify(0)} \\{classify(1)} \\{classify(9)}")
`);
});

// --- while_promotion.test.ts ---
// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.
test("while with promotion, break and continue is byte-identical", () => {
	expect_byte_identical(`
func sum_odd_to = (int n, out int) {
    var int total = 0
    var int i = 0
    while i < n {
        i = i + 1
        if i % 2 == 0 {
            continue
        }
        if i > 7 {
            break
        }
        total = total + i
    }
    return total
}
Console.write("\\{sum_odd_to(5)} \\{sum_odd_to(20)}")
`);
});
