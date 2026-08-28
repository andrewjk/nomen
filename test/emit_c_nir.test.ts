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
 * same source twice — emission cursor off (baseline) vs on — and requires the
 * generated C to match exactly.
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

test("match/switch arms with assignment expressions fall back and stay byte-identical", () => {
	// White-box: `case X -> target = value` parses the assignment as a LET
	// wrapping an assign EXPRESSION; from_ast has no assign-expression
	// mapping yet, so the arm lowers to `other` (unknown "assign") and the
	// whole function rides the AST fallback. Byte-identity must hold — and
	// this test turns green coverage the day assign-expressions lower.
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
	expect([...nir.unknown_kinds]).toContain("assign");
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

test("functions with unmapped statements fall back to the AST walk", () => {
	// White-box: a nested struct declaration is not modeled in NIR → the
	// whole enclosing function is ineligible (unknown_kinds non-empty) and
	// its statements ride the AST path. Byte-identity must hold regardless.
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
	expect([...nir.unknown_kinds]).toContain("struct");
	expect_byte_identical(source);
});

test("async nursery blocks delegate byte-identically", () => {
	// The async body is a delegated block: build_async_block_node calls
	// build_block_node directly, so the identity guard must fall back to the
	// AST walk inside it even though the enclosing function's cursor is
	// active. A bare nursery-spawn statement rides the delegated eval path,
	// whose fire-and-forget stamp is build_node's with_semicolon side effect.
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
