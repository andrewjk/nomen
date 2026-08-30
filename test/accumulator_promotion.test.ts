import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";

/**
 * Accumulator-aware loop promotion (ASM_PLAN_2 tranche D): a variable
 * WRITTEN in a loop body is a loop-carried accumulator — its slot
 * round-trip executes every iteration even when the TEXT has a single
 * read. Those qualify for promotion with reads >= 1 (aliased/ref/heap
 * storage stays excluded).
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

const SPECTRAL_SHAPE = `
import System

func eval_a_times_u = (ref Buffer<float> au, ref Buffer<float> u, int n) {
	if n <= au.cap && n <= u.cap {
		var i = 0
		while i < n; i += 1 {
			var a = 0.0
			var j = 0
			while j < n; j += 1 {
				a = a + u.load_float(j) * 2.0
			}
			au.store_float(i, a)
		}
	}
}
pub func main = () {}
`;

test("loop accumulator declared in the body gets promoted (spectral shape)", () => {
	const code = compile(SPECTRAL_SHAPE);
	const fn = code.slice(code.indexOf("\neval_a_times_u:"), code.indexOf("\n_main:"));
	// `a` must live in a promoted d-register: the add writes a d-reg
	// directly and the store_float reads that register — no slot
	// round-trip for the accumulator.
	expect(fn).toMatch(/fadd d\d+, d\d+, d\d+/);
	expect(fn).not.toMatch(/str d\d+, \[x29, #\d+\]\s*\n\s*\.?end/);
});

test("behavioral: accumulator loop prints exact results", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func scale_rows = (ref Buffer<float> au, ref Buffer<float> u, int n) {
	if n <= au.cap && n <= u.cap {
		var i = 0
		while i < n; i += 1 {
			var a = 0.0
			var j = 0
			while j < n; j += 1 {
				a = a + u.load_float(j) * 2.0
			}
			au.store_float(i, a)
		}
	}
}
pub func main = () {
	var u = Buffer<float>()
	var au = Buffer<float>()
	u.alloc_float(4)
	au.alloc_float(4)
	if u.cap >= 4 && au.cap >= 4 {
		var k = 0
		while k < 4; k += 1 {
			u.store_float(k, k as float + 1.0)
		}
		scale_rows(ref au, ref u, 4)
		var j = 0
		while j < 4; j += 1 {
			Console.write("\\{au.load_float(j)} ")
		}
	}
}
`,
		"accumulator_promotion",
		"20.000000 20.000000 20.000000 20.000000 ",
		true,
	);
});
