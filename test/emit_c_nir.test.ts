import fs from "node:fs";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_c_nir_emission_enabled } from "../src/build_c/emit_nir";
import join from "../src/join";
import { get_library } from "../src/lib";
import { lower_function } from "../src/nir/from_ast";
import parse from "../src/parse";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

/**
 * Phase 4 canonical-IR stage 2+ (ASM_PLAN): the C backend consumes the same
 * NIR emission seam as the aarch64 backend. NIR-driven emission must be a
 * byte-identical re-encoding of the AST walk. Every test here compiles the
 * same source twice — per-statement delegation off/on (the emission toggle
 * makes emit_stmt_from_nir delegate every statement to build_node, the exact
 * statement-level walk the retired whole-function fallback performed) — and
 * requires the generated C to match exactly.
 */

function compile_c(source: string, raw = false): { code: string; headers: string } {
	const parsed = raw ? parse_raw(source) : parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "c" });
	return { code: result.code, headers: result.headers };
}

function expect_byte_identical(source: string, raw = false): void {
	set_c_nir_emission_enabled(false);
	const baseline = compile_c(source, raw);
	set_c_nir_emission_enabled(true);
	try {
		const with_nir = compile_c(source, raw);
		expect(with_nir.code.length).toBeGreaterThan(0);
		expect(with_nir).toEqual(baseline);
	} finally {
		set_c_nir_emission_enabled(true);
	}
}

test("if/else chains are byte-identical through the C NIR emission path", () => {
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

test("while with update, break and continue is byte-identical", () => {
	expect_byte_identical(`
var int total = 0
var int i = 0
while i < 20; i += 1 {
    if i % 2 == 0 {
        continue
    }
    if i > 7 {
        break
    }
    total = total + i
}
Console.write("\\{total}")
`);
});

test("nested while loops stay byte-identical", () => {
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

test("range for loops emit NIR-natively (nested ifs NIR-driven)", () => {
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

test("array-iteration for loops are byte-identical", () => {
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

test("for ref of array (writeback path) is byte-identical", () => {
	expect_byte_identical(`
func decrement_all = (out int) {
    var int[] nums = [3, 1, 2]
    for ref n of nums {
        n = n - 1
    }
    var int sum = 0
    for n of nums {
        sum = sum + n
    }
    return sum
}
Console.write("\\{decrement_all()}")
`);
});

test("switch statements are byte-identical", () => {
	expect_byte_identical(`
var int x = 500
switch {
    case x > 100 -> Console.write("big")
    case x > 10 -> Console.write("medium")
    else -> Console.write("small")
}
`);
});

test("simple enum match is byte-identical", () => {
	expect_byte_identical(`
enum Color {
    case red
    case green
    case blue
}

func show = (Color c) {
    match c {
        case .red -> Console.write("red")
        case .green -> Console.write("green")
        case .blue -> Console.write("blue")
    }
}
show(Color.red)
show(Color.green)
`);
});

test("associated-data match with payload bindings is byte-identical", () => {
	// Parsed raw so the enum can live at module scope. Covers BOTH match
	// emission paths' arm threading (simple switch-form via the enum WITHOUT
	// data and the if-chain form via the enum WITH data) and the hoisted
	// scrutinee temp. Arrow arms carry call statements (an assignment in an
	// arrow arm is a let-wrapped assign EXPRESSION — a known from_ast coverage
	// gap that forces the per-function AST fallback, tested separately).
	expect_byte_identical(
		`
import System

enum Shape {
    case circle(int radius)
    case unit
}

func describe = (Shape s) {
    match s {
        case .circle(r) -> Console.write("\\{3 * r}")
        case .unit -> Console.write("1")
        else -> Console.write("0")
    }
}

func make = (int r, out Shape) {
    return Shape.circle(r)
}

pub func main = () {
    describe(Shape.circle(2))
    describe(Shape.unit)
    describe(make(5))
}
`,
		true,
	);
});

test("deeply nested flow (if in while in for, loop in match arm) is byte-identical", () => {
	expect_byte_identical(
		`
import System

enum Op {
    case add
    case sub
}

func apply = (Op op, int seed, out int) {
    var int acc = seed
    match op {
        case .add {
            for i of 0 .. 4 {
                var int j = 0
                while j < 3 {
                    if j % 2 == 0 {
                        acc = acc + i
                    }
                    j = j + 1
                }
            }
        }
        case .sub {
            acc = acc - 1
        }
        else {
            acc = 0
        }
    }
    return acc
}
Console.write("\\{apply(Op.add, 10)} \\{apply(Op.sub, 10)}")
`,
		true,
	);
});

test("match/switch arms with assignment expressions lower to the assign KIND", () => {
	// White-box: `case X -> target = value` parses the assignment as a LET
	// wrapping an assign EXPRESSION; from_ast lowers it to the assign KIND
	// (not `other`), so the function stays NIR-eligible (unknown_kinds empty)
	// and the match/switch statements ride the cursor — byte-identity must
	// hold through the NIR-native dispatch.
	const source = `
func pick = (int x, out string) {
    var string s = "?"
    match x {
        case 1 -> s = "one"
        else -> s = "many"
    }
    switch {
        case x > 10 -> s = "big"
        else -> s = "small"
    }
    return s
}
Console.write("\\{pick(1)} \\{pick(50)}")
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
	const fn = walk(parsed.root).find((f: any) => f.name === "pick");
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	// The arm lets lowered to assign statements carrying the INNER
	// AssignmentNode (not the wrapping let).
	const match_stmt = nir.body.find((s) => s.kind === "switch_match");
	expect(match_stmt).toBeTruthy();
	for (const arm of match_stmt!.kind === "switch_match" ? match_stmt!.arms : []) {
		expect(arm.branch.map((s) => s.kind)).toEqual(["assign"]);
		expect(arm.branch[0].node.node_type).toBe("assign");
	}
	expect_byte_identical(source);
});

test("raw #arch: c statements delegate byte-identically", () => {
	expect_byte_identical(
		`
import System

var int x = 1
\`\`\`
#arch: c
x = 5;
\`\`\`
Console.write("\\{x}")
`,
		true,
	);
});

test("nested struct statements lower to opaque and stay NIR-eligible", () => {
	// White-box: a nested struct declaration lowers to `opaque` WITHOUT
	// recording (type declarations are skipped by the block loop — their IR
	// entries are never dispatched), so the function stays NIR-eligible and
	// every statement dispatches through the seam. Byte-identity must hold.
	const source = `
func make_point = (out int) {
    struct Pt {
        var int x
        var int y
    }
    var Pt p = Pt(3, 4)
    return p.x + p.y
}
Console.write("\\{make_point()}")
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
	const fn = walk(parsed.root).find((f: any) => f.name === "make_point");
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	expect(nir.body.some((s) => s.kind === "opaque")).toBe(true);
	expect_byte_identical(source);
});

test("async nursery bodies with nursery.spawn stay byte-identical", () => {
	// The async body installs its own cursor via the async_block dispatch
	// arm, so its statements dispatch NIR-natively. `nursery.spawn(...)`
	// statements ride the delegated eval path (an access method-call, not a
	// SpawnNode), whose fire-and-forget stamp is build_node's with_semicolon
	// side effect — the eval arm re-stamps it.
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

test("return values of every expression shape emit through the C expression seam", () => {
	// C expression-seam tranche: the return arm threads the lowered value
	// through emit_expr_from_nir — leaf, binary, grouped, cast, call shapes,
	// plus returns from nested flow arms (which install their own cursors).
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
func half_of = (float v, out float) {
    return v / 2.0
}
func greet = (string who, out string) {
    if who == "world" {
        return "hi " + who
    }
    return who
}
Console.write("\\{shape_test(0)} \\{shape_test(1)} \\{shape_test(2)} \\{shape_test(3)} \\{shape_test(9)}")
Console.write("\\{first_hit(10)} \\{half_of(1.0)} \\{greet("world")} \\{greet("bob")}")
`);
});

test("array literal returns ride the NIR element facts byte-identically", () => {
	// The C return path materializes the literal into a stack C array
	// initializer; each element descends the seam via nir_array_elements.
	// The call-returned array is iterated directly (`for v of triple()`):
	// build_for_loop_node materializes it into a heap temp and iterates the
	// temp's header length.
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

test("declare/assign/eval statements emit through the C NIR seam byte-identically", () => {
	// C expression-seam tranche: declares of every initializer shape (literal,
	// op, grouped, cast, string concat, struct ctor, fixed array),
	// assignments (plain, compound scalar/field/float, string re-concat,
	// indexed store, trait-dispatch field set), and bare-expression statements
	// (free call, method call). Parsed raw so the struct can live at module
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
    var int spare
    var int[] empties
    c.count = base
    c.count += 4
    c.label = "set"
    base = bump(base)
    base += 2
    ratio += 0.25
    greeting = greeting + "!"
    spare = 4
    nums.set(0, 9)
    nums.set(1, base)
    bump(base)
    Console.write("\\{base} \\{ratio} \\{greeting} \\{c.count} \\{c.label} \\{nums.at(0)} \\{nums.at(1)} \\{spare}")
}
`,
		true,
	);
});

test("bare nursery-spawn statements stay fire-and-forget through the C eval seam", () => {
	// The delegated path stamps is_statement on a nursery-spawn statement via
	// build_node's with_semicolon side effect; the eval arm replicates the
	// stamp — a missed stamp would emit a joined (waited) task, an observable
	// difference this byte-identity test would catch.
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

test("nullable struct declares and assignments marshal through the C seam", () => {
	// Nullable struct slots carry a companion `<name>_has` flag in C; the
	// declaration initializer and assignment RHS are value positions on the
	// seam (null / non-null paths both exercised).
	expect_byte_identical(
		`
import System

struct Point {
    var int x
    var int y
}

func make = (int x, out Point?) {
    return Point(x, x * 2)
}

pub func main = () {
    var Point? p = make(7)
    var Point? q = null
    q = make(3)
    q = null
    if p != null {
        Console.write("\\{p.x}|\\{p.y} ")
    }
    if q == null {
        Console.write("null")
    }
}
`,
		true,
	);
});

test("assignment swaps marshal through the C NIR seam byte-identically", () => {
	// The swap replacement (`a = b swap <rep>`) is a value emission inside the
	// swap marshalling, for both variable-RHS and field-RHS swap shapes.
	expect_byte_identical(
		`
import System

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
`,
		true,
	);
});

test("declaration swaps marshal through the C NIR seam byte-identically", () => {
	// `var Pt c = mov w.pt swap <rep>` — the value-struct declaration path's
	// swap replacement rides the seam too (the moved-out field is revalidated
	// with the replacement after the bytes transfer to the local).
	expect_byte_identical(
		`
import System

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
`,
		true,
	);
});

test("whole benchmark corpus is byte-identical through the C NIR emission path", () => {
	const bench_dir = "bench/nomen";
	const lib = get_library("core");
	for (const file of fs.readdirSync(bench_dir)) {
		if (!file.endsWith(".nm")) continue;
		const source = join(`${bench_dir}/${file}`, "core");
		const compile = (): string => {
			const parsed = parse(source, lib);
			expect(parsed.errors, file).toEqual([]);
			const result = build(parsed.root, { arch: "c" });
			return result.code;
		};
		set_c_nir_emission_enabled(false);
		const baseline = compile();
		set_c_nir_emission_enabled(true);
		try {
			expect(compile(), file).toEqual(baseline);
		} finally {
			set_c_nir_emission_enabled(true);
		}
	}
});

test("C binaries built through the NIR path run correctly", async () => {
	// Behavioral belt-and-braces (runs BOTH backends; the C half is the one
	// under test here): while with break/continue, range for with nested if,
	// and a match with payload bindings — all NIR-driven. sum_odd_to(20)
	// stops at the break after i=9 → 1+3+5+7 = 16; count_even(10) = 5;
	// area(circle 6) = 18, area(unit) = 1. (Console.write adds no newline.)
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func sum_odd_to = (int n, out int) {
    var int total = 0
    var int i = 0
    while i < n; i += 1 {
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

func count_even = (int n, out int) {
    var int c = 0
    for i of 0 .. n {
        if i % 2 == 0 {
            c = c + 1
        }
    }
    return c
}

enum MyShape {
    case circle(int radius)
    case unit
}

func area_of = (MyShape s, out int) {
    var int area = 0
    match s {
        case .circle(r) {
            area = 3 * r
        }
        case .unit {
            area = 1
        }
        else {
            area = 0
        }
    }
    return area
}

pub func main = () {
    Console.write("\\{sum_odd_to(20)} \\{count_even(10)}")
    var MyShape s = MyShape.circle(6)
    Console.write(" \\{area_of(s)} \\{area_of(MyShape.unit)}")
}
`,
		"emit_c_nir_behavior",
		"16 5 18 1",
		true,
	);
});

test("C binaries built through the expression seam run correctly", async () => {
	// Behavioral belt-and-braces for the expression-seam tranche: base 10 →
	// bump → 11 → +=2 → 13; ratio 0.5+0.25 → 0.750000; greeting "hi there" +
	// "!"; c.count 10+4=14; c.label "set"; nums[0]=9, nums[1]=13; a = b swap
	// 99 → a=2 (b's old value), b=99; var Pt c = mov w.pt swap Pt(5,5) →
	// c.x=4, w.pt.x=5 → 45. (Console.write adds no newline.)
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

struct Counter {
    var int count
    var string label
}
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

func bump = (int by, out int) {
    return by + 1
}

func run_swap = (out int) {
    var Box a = Box(1)
    var Box b = Box(2)
    a = b swap Box(7)
    return a.value * 10 + b.value
}

func run_decl_swap = (out int) {
    var Wrap w = Wrap(Pt(4, 4))
    var Pt c = mov w.pt swap Pt(5, 5)
    return c.x * 10 + w.pt.x
}

pub func main = () {
    var int base = 10
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
    Console.write(" \\{run_swap()} \\{run_decl_swap()}")
}
`,
		"emit_c_nir_expr_seam_behavior",
		"13 0.750000 hi there! 14 set 9 13 27 45",
		true,
	);
});

test("value-position match/if/switch join through the seam byte-identically (C)", () => {
	// The Container.nm pattern on the C backend: match/if/switch as a
	// DECLARATION initializer lowers to a `flow` expr; the declaration's
	// init site descends the seam, whose flow arm routes the original node
	// to the join-slot builders.
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

test("value-position spawn stays NIR-eligible byte-identically (C)", () => {
	expect_byte_identical(`
func work = (uint64 arg) {
    Console.write_line("worked")
}
pub func main = () {
    var t = spawn work(3)
    t.wait()
}
`);
});

test("async nursery body dispatches NIR-natively with nested flow (C)", () => {
	// The async_block dispatch arm hands build_async_block_node the lowered
	// body; the nursery's block installs its own cursor so the nested if
	// dispatches NIR-natively instead of riding the AST walk.
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
