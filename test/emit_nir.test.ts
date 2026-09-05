import fs from "node:fs";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_access_staging_enabled } from "../src/build_aarch64/access_staging";
import { set_buffer_pipeline_enabled } from "../src/build_aarch64/buffer_pipeline";
import { set_cset_lowering_enabled } from "../src/build_aarch64/cset_lower";
import { set_nir_emission_enabled } from "../src/build_aarch64/emit_nir";
import { set_flag_form_enabled } from "../src/build_aarch64/flag_form";
import { set_forwarding_enabled } from "../src/build_aarch64/forward";
import { set_neon_vectorization_enabled } from "../src/build_aarch64/neon_emit";
import { set_slp_pair_enabled } from "../src/build_aarch64/slp_pair";
import { set_loop_unrolling_enabled } from "../src/build_aarch64/unroll";
import { set_nir_site_promotion_enabled } from "../src/build_aarch64/utils/nir_regalloc";
import { set_value_numbering_enabled } from "../src/build_aarch64/value_number";
import join from "../src/join";
import { get_library } from "../src/lib";
import { lower_function } from "../src/nir/from_ast";
import parse from "../src/parse";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

/**
 * Phase 4 canonical-IR stage 2 (ASM_PLAN): NIR-driven emission must be a
 * byte-identical re-encoding of the AST walk. Every test here compiles the
 * same source twice — per-statement delegation off/on (the emission toggle
 * makes emit_stmt_from_nir delegate every statement to build_node, the exact
 * statement-level walk the retired whole-function fallback performed) — and
 * requires the generated aarch64 assembly to match exactly.
 *
 * The NEON vectorizer rides the same NIR cursor but INTENTIONALLY changes
 * output, so it is held off in both arms: these tests prove the seam
 * mechanics, not the vectorizer (see test/neon_vector.test.ts).
 */

function compile_aarch64(source: string, raw = false): string {
	const parsed = raw ? parse_raw(source) : parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	return result.code;
}

function expect_byte_identical(source: string, raw = false): void {
	set_nir_emission_enabled(false);
	set_neon_vectorization_enabled(false);
	// Decl-site register binding (tranche G stage 3) is cursor-dependent by
	// design: the site hook fires only when emit_stmt_from_nir owns the
	// statement, so the delegated baseline arm could never reproduce it.
	// Hold it off in both arms — the same treatment the NEON vectorizer
	// gets — so the harness keeps proving the SEAM mechanics. The cset
	// fuse (ASM_PLAN_3 tranche B) is cursor-dependent the same way, and so
	// is the stage-4 forwarding pass (its one-statement AST swap rides the
	// cursor's use-site plan).
	set_nir_site_promotion_enabled(false);
	set_cset_lowering_enabled(false);
	set_forwarding_enabled(false);
	// The carry-fold fuse (ASM_PLAN_3 tranche J) consumes up to four
	// statements through the cursor — same treatment as the cset fuse.
	set_flag_form_enabled(false);
	set_buffer_pipeline_enabled(false);
	// Access staging (ASM_PLAN_3 tranche L) is window-state-dependent: a
	// pin filled by an earlier statement can never reproduce in a
	// delegated single-statement rebuild — same treatment as the fuses.
	set_access_staging_enabled(false);
	// Loop value numbering (ASM_PLAN_3 tranche M) rewrites the NIR spine
	// AND the statement lists the delegated walk builds from — the two arms
	// could never agree — same treatment as the fuses.
	set_value_numbering_enabled(false);
	// Field-pair SLP (ASM_PLAN_4) consumes adjacent statement pairs and
	// plans lane pairs in the allocators — cursor-dependent, same
	// treatment as the fuses.
	set_slp_pair_enabled(false);
	const baseline = compile_aarch64(source, raw);
	set_nir_emission_enabled(true);
	try {
		const with_nir = compile_aarch64(source, raw);
		expect(with_nir.length).toBeGreaterThan(0);
		expect(with_nir).toEqual(baseline);
	} finally {
		set_nir_emission_enabled(true);
		set_neon_vectorization_enabled(true);
		set_nir_site_promotion_enabled(true);
		set_cset_lowering_enabled(true);
		set_forwarding_enabled(true);
		set_flag_form_enabled(true);
		set_buffer_pipeline_enabled(true);
		set_access_staging_enabled(true);
		set_value_numbering_enabled(true);
		set_slp_pair_enabled(true);
	}
}

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

test("match arms emit NIR-natively byte-identically", () => {
	expect_byte_identical(`
func describe = (int x, out string) {
    var string label = "other"
    match x {
        case 1 -> label = "one"
        case 2 -> label = "two"
        else -> label = "many"
    }
    return label
}
Console.write("\\{describe(1)} \\{describe(5)}")
`);
});

test("enum-with-data match with payload bindings emits NIR-natively", () => {
	// Module-level enum + match-with-payloads: parsed raw (parse_with_imports
	// wraps the source inside main, where enums can't be declared).
	expect_byte_identical(
		`
import System

enum MyShape {
    case circle(int radius)
    case unit
}

func area_of = (MyShape s, out int) {
    var int area = 0
    match s {
        case .circle(r) -> area = 3 * r
        case .unit -> area = 1
        else -> area = 0
    }
    return area
}

pub func main = () {
    Console.write("\\{area_of(MyShape.circle(2))} \\{area_of(MyShape.unit)}")
}
`,
		true,
	);
});

test("switch chains emit NIR-natively byte-identically", () => {
	expect_byte_identical(`
func size_of = (int x, out string) {
    var string s = "small"
    switch {
        case x > 100 -> s = "big"
        case x > 10 -> s = "medium"
        else -> s = "small"
    }
    return s
}
Console.write("\\{size_of(500)} \\{size_of(3)}")
`);
});

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
            else -> acc = acc + 1
        }
    }
    return acc
}
Console.write("\\{nested_flow(6)}")
`);
});

test("raw aarch64 statements delegate byte-identically", () => {
	expect_byte_identical(`
var int x = 1
\`\`\`
#arch: aarch64
ldr x0, =5
\`\`\`
Console.write("\\{x}")
`);
});

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

test("nested struct statements lower to opaque and stay NIR-eligible", () => {
	const source = `
func nested_type = (out int) {
    struct P {
        var int x
    }
    var int v = 3
    if v > 0 {
        return v
    }
    return 0
}
Console.write("\\{nested_type()}")
`;
	// White-box: the nested struct declaration lowers to `opaque` WITHOUT
	// recording (type declarations are skipped by the block loop — their IR
	// entries are never dispatched), so the function stays NIR-eligible.
	const parsed = parse_with_imports(source);
	const walk = (n: any): any[] => {
		if (!n || typeof n !== "object") return [];
		if (Array.isArray(n)) return n.flatMap(walk);
		const found = n.node_type === "func" ? [n] : [];
		return found.concat(
			Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk(n[k]))),
		);
	};
	const fn = walk(parsed.root).find((f) => f.name === "nested_type");
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	expect(nir.body.some((s) => s.kind === "opaque")).toBe(true);
	expect_byte_identical(source);
});

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

test("return match emits NIR-natively through the join-slot path", () => {
	const source = `
func pick = (int x, out int) {
    return match x {
        case 1 -> 10
        else -> 20
    }
}
Console.write("\\{pick(1)} \\{pick(2)}")
`;
	// White-box: a match in return-value position lowers to a `flow` expr
	// (was: `other` → whole-function fallback). The NIR return arm descends
	// the expression seam, whose flow arm routes the ORIGINAL match node
	// through build_node to the same join-slot builders — byte-identical.
	const parsed = parse_with_imports(source);
	const walk = (n: any): any[] => {
		if (!n || typeof n !== "object") return [];
		if (Array.isArray(n)) return n.flatMap(walk);
		const found = n.node_type === "func" ? [n] : [];
		return found.concat(
			Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk(n[k]))),
		);
	};
	const fn = walk(parsed.root).find((f) => f.name === "pick");
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	const ret = nir.body.find((s) => s.kind === "return");
	expect(ret && ret.kind === "return" && ret.value?.kind === "flow").toBe(true);
	expect_byte_identical(source);
});

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
        else -> 300
    }
    var int bump = if kind > 150 -> 5
                   else -> 1
    var int wrap = switch {
        case kind == 100 -> 7
        else -> 9
    }
    return kind + bump + wrap
}
Console.write("\\{classify(0)} \\{classify(1)} \\{classify(9)}")
`);
});

test("function-typed declarations (`var func`) stay NIR-eligible byte-identically", () => {
	// A declared function variable's value IS a FunctionNode — it lowers to a
	// nameless leaf, and the seam routes build_node to it (which builds the
	// function and emits its label exactly as the AST walk did).
	const source = `
pub func main = () {
    var func (int) handler {
        Console.write_line("handled")
    }
    handler(1)
}
`;
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	const walk = (n: any): any[] => {
		if (!n || typeof n !== "object") return [];
		if (Array.isArray(n)) return n.flatMap(walk);
		const found = n.node_type === "func" ? [n] : [];
		return found.concat(
			Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk(n[k]))),
		);
	};
	const fn = walk(parsed.root).find(
		(f) => f.name === "main" && f.statements.some((s: any) => s.node_type === "declare"),
	);
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	const decl = nir.body.find((s) => s.kind === "declare");
	expect(
		decl &&
			decl.kind === "declare" &&
			decl.decl.init?.kind === "leaf" &&
			decl.decl.init.node.node_type === "func",
	).toBe(true);
	expect_byte_identical(source);
});

test("value-position spawn lowers to the spawn expr and stays NIR-eligible", () => {
	const source = `
func work = (uint64 arg) {
    Console.write_line("worked")
}
pub func main = () {
    var t = spawn work(3)
    t.wait()
}
`;
	const parsed = parse_with_imports(source);
	const walk = (n: any): any[] => {
		if (!n || typeof n !== "object") return [];
		if (Array.isArray(n)) return n.flatMap(walk);
		const found = n.node_type === "func" ? [n] : [];
		return found.concat(
			Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk(n[k]))),
		);
	};
	// NOTE: parse_with_imports wraps the source with a synthetic main stub —
	// pick the USER main (the one holding the declare).
	const fn = walk(parsed.root).find(
		(f) => f.name === "main" && f.statements.some((s: any) => s.node_type === "declare"),
	);
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	const decl = nir.body.find((s) => s.kind === "declare");
	expect(decl && decl.kind === "declare" && decl.decl.init?.kind === "spawn").toBe(true);
	expect_byte_identical(source);
});

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
        spawn probe(1)
        if total == 0 {
            total = total + 40
        }
    }
    return total
}
Console.write("\\{nursery_flow()}")
`);
});

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
    nursery.spawn(work(1))
    var t = nursery.spawn(work(2))
    t.wait()
}
`);
});

test("NIR-native declare/assign/eval binaries run correctly", async () => {
	// Behavioral belt-and-braces for the tranche-4 paths. base: 10 → bump →
	// 11 → +=2 → 13; scaled=30, grp=12, wide=10 at declaration time;
	// ratio 0.5+0.25 → "0.750000"; greeting "hi there" + "!";
	// c.count 10+4=14; nums[0]=9. (Console.write adds no newline.)
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
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
		"emit_nir_decl_assign_eval",
		"13 0.750000 hi there! 14 set 9 13",
		true,
	);
});

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

test("assignment swaps marshal through the NIR seam byte-identically", () => {
	// Tranche 5: the swap replacement (`a = b swap <rep>`) is a value
	// emission inside the swap marshalling, for both variable-RHS and
	// field-RHS swap shapes.
	expect_byte_identical(`
class Box {
  var int value
}
class Holder {
  mov Box content
}
func run_swap_var = (out int) {
  var Box a = Box(1)
  var Box b = Box(2)
  a = b swap Box(7)
  return a.value * 10 + b.value
}
func run_swap_field = (out int) {
  var Holder h1 = Holder(mov Box(1))
  var Holder h2 = Holder(mov Box(2))
  h1.content = h2.content swap Box(99)
  return h1.content.value * 100 + h2.content.value
}
Console.write("\\{run_swap_var()} \\{run_swap_field()}")
`);
});

test("declaration swaps marshal through the NIR seam byte-identically", () => {
	// Tranche 5: `var Pt c = mov w.pt swap <rep>` — the value-struct
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
  var Pt c = mov w.pt swap Pt(5, 5)
  return c.x * 10 + w.pt.x
}
Console.write("\\{run_decl()}")
`);
});

test("NIR-native swap and address-RHS binaries run correctly", async () => {
	// Behavioral belt-and-braces for the tranche-5 paths: p = mk(3) → (3,4)
	// → 7; a = b swap Box(7) → a=2, b=7 → 27; h1.content = h2.content swap
	// Box(99) → h1=2, h2=99 → 299; var Pt c = mov w.pt swap Pt(5,5) → c.x=4,
	// w.pt.x=5 → 45.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
struct Pt {
  var int x
  var int y
}
struct Wrap {
  var Pt pt
}
class Box {
  var int value
}
class Holder {
  mov Box content
}
func mk = (int a, out Pt) {
  return Pt(a, a + 1)
}
func run_addr = (out int) {
  var Pt p = Pt(0, 0)
  p = mk(3)
  return p.x + p.y
}
func run_swap_var = (out int) {
  var Box a = Box(1)
  var Box b = Box(2)
  a = b swap Box(7)
  return a.value * 10 + b.value
}
func run_swap_field = (out int) {
  var Holder h1 = Holder(mov Box(1))
  var Holder h2 = Holder(mov Box(2))
  h1.content = h2.content swap Box(99)
  return h1.content.value * 100 + h2.content.value
}
func run_decl = (out int) {
  var Wrap w = Wrap(Pt(4, 4))
  var Pt c = mov w.pt swap Pt(5, 5)
  return c.x * 10 + w.pt.x
}
Console.write("\\{run_addr()} \\{run_swap_var()} \\{run_swap_field()} \\{run_decl()}")
`,
		"emit_nir_swap_addr",
		"7 27 299 45",
	);
});

test("whole benchmark corpus is byte-identical through NIR emission", () => {
	const bench_dir = "bench/nomen";
	const lib = get_library("core");
	for (const file of fs.readdirSync(bench_dir)) {
		if (!file.endsWith(".nm")) continue;
		const source = join(`${bench_dir}/${file}`, "core");
		const compile = (): string => {
			const parsed = parse(source, lib);
			expect(parsed.errors, file).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64" });
			return result.code;
		};
		// The NEON vectorizer and the full unroller intentionally change
		// output, so both are held off in both arms (see the harness comment
		// at the top of this file). Decl-site register binding (tranche G
		// stage 3) is cursor-dependent the same way, as is the cset fuse
		// (ASM_PLAN_3 tranche B) — it consumes a declare AND its following
		// if through the cursor — and the stage-4 forwarding pass (its
		// use-site AST swap rides the cursor).
		set_nir_emission_enabled(false);
		set_neon_vectorization_enabled(false);
		set_loop_unrolling_enabled(false);
		set_nir_site_promotion_enabled(false);
		set_cset_lowering_enabled(false);
		set_forwarding_enabled(false);
		set_flag_form_enabled(false);
		set_buffer_pipeline_enabled(false);
		set_access_staging_enabled(false);
		set_value_numbering_enabled(false);
		set_slp_pair_enabled(false);
		const baseline = compile();
		set_nir_emission_enabled(true);
		set_neon_vectorization_enabled(false);
		set_loop_unrolling_enabled(false);
		set_nir_site_promotion_enabled(false);
		set_cset_lowering_enabled(false);
		set_forwarding_enabled(false);
		set_flag_form_enabled(false);
		set_buffer_pipeline_enabled(false);
		set_access_staging_enabled(false);
		set_value_numbering_enabled(false);
		set_slp_pair_enabled(false);
		try {
			expect(compile(), file).toEqual(baseline);
		} finally {
			set_nir_emission_enabled(true);
			set_neon_vectorization_enabled(true);
			set_loop_unrolling_enabled(true);
			set_nir_site_promotion_enabled(true);
			set_cset_lowering_enabled(true);
			set_forwarding_enabled(true);
			set_flag_form_enabled(true);
			set_buffer_pipeline_enabled(true);
			set_access_staging_enabled(true);
			set_value_numbering_enabled(true);
			set_slp_pair_enabled(true);
		}
	}
});

test("NIR-built binaries still run correctly", async () => {
	// Behavioral belt-and-braces: the default (NIR-on) build must produce a
	// binary whose output matches — loop promotion rides the shared helper,
	// break/continue interaction included. sum_odd_to(5) = 1+3+5 = 9;
	// sum_odd_to(20) stops at the break after i=9 → 1+3+5+7 = 16.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
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
`,
		"emit_nir_promotion",
		"9 16",
	);
});

test("NIR-native return-heavy binaries run correctly", async () => {
	// Behavioral belt-and-braces for the return/expression tranche: returns of
	// leaf/binary/call/grouped shapes across if/while/for arms, plus float (d0,
	// %f-formatted) and string (borrow-normalized) returns — all through the
	// NIR expression seam. first_hit(10)=5 (5²>20), scan_up(2)=0, scan_up(9)=40;
	// shape_test row = 0 9 14 -9; scale row = 5.0 0.75; greet = "hi world" bob.
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
func helper = (int v, out int) {
    return v * 2
}
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
func shape_test = (int n, out int) {
    if n == 0 {
        return 0
    }
    if n == 1 {
        return (n + 2) * 3
    }
    if n == 3 {
        return helper(n) + helper(n + 1)
    }
    return 0 - n
}
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
Console.write("\\{first_hit(10)} \\{scan_up(2)} \\{scan_up(9)}")
Console.write(" \\{shape_test(0)} \\{shape_test(1)} \\{shape_test(3)} \\{shape_test(9)}")
Console.write(" \\{scale(2.0)} \\{scale(0.5)}")
Console.write(" \\{greet("world")} \\{greet("bob")}")
`,
		"emit_nir_returns",
		"5 0 40 0 9 14 -9 5.000000 0.750000 hi world bob",
	);
});

test("NIR-native for/match binaries run correctly", async () => {
	// Behavioral belt-and-braces for the tranche-2 paths: array-iteration for
	// (with nested if), for-ref writeback, and enum-with-data match arms with
	// payload bindings. nums=[3,1,2] → sum of >1 elements = 3+2 = 5; ref loop
	// decrements each element once → sum = 2+0+1 = 3; area(circle 2) = 6,
	// area(unit) = 1. (Console.write adds no newline → "536 1".)
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

enum MyShape {
    case circle(int radius)
    case unit
}

func area_of = (MyShape s, out int) {
    var int area = 0
    match s {
        case .circle(r) -> area = 3 * r
        case .unit -> area = 1
        else -> area = 0
    }
    return area
}

pub func main = () {
    var int[] nums = [3, 1, 2]
    var int sum = 0
    for n of nums {
        if n > 1 {
            sum = sum + n
        }
    }
    Console.write("\\{sum}")
    for ref n of nums {
        n = n - 1
    }
    var int total = 0
    for n of nums {
        total = total + n
    }
    Console.write("\\{total}")
    var MyShape s = MyShape.circle(2)
    var int area = 0
    match s {
        case .circle(r) -> area = 3 * r
        case .unit -> area = 1
        else -> area = 0
    }
    Console.write("\\{area} \\{area_of(MyShape.unit)}")
}
`,
		"emit_nir_for_match",
		"536 1",
		true,
	);
});
