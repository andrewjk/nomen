import fs from "node:fs";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_nir_emission_enabled } from "../src/build_aarch64/emit_nir";
import join from "../src/join";
import { get_library } from "../src/lib";
import { lower_function } from "../src/nir/from_ast";
import parse from "../src/parse";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

/**
 * Phase 4 canonical-IR stage 2 (ASM_PLAN): NIR-driven emission must be a
 * byte-identical re-encoding of the AST walk. Every test here compiles the
 * same source twice — emission cursor off (baseline) vs on — and requires
 * the generated aarch64 assembly to match exactly.
 */

function compile_aarch64(source: string, raw = false): string {
	const parsed = raw ? parse_raw(source) : parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	return result.code;
}

function expect_byte_identical(source: string, raw = false): void {
	set_nir_emission_enabled(false);
	const baseline = compile_aarch64(source, raw);
	set_nir_emission_enabled(true);
	try {
		const with_nir = compile_aarch64(source, raw);
		expect(with_nir.length).toBeGreaterThan(0);
		expect(with_nir).toEqual(baseline);
	} finally {
		set_nir_emission_enabled(true);
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

test("function with a nested struct falls back and stays byte-identical", () => {
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
	// White-box: the nested struct declaration must make the function
	// ineligible (unknown_kinds non-empty), exercising the fallback.
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
	expect([...nir.unknown_kinds]).toContain("struct");
	expect_byte_identical(source);
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
		set_nir_emission_enabled(false);
		const baseline = compile();
		set_nir_emission_enabled(true);
		try {
			expect(compile(), file).toEqual(baseline);
		} finally {
			set_nir_emission_enabled(true);
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
