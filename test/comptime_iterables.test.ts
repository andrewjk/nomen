import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { compile_module } from "./spec/_helpers.ts";

// Compile-time iterables (stage 6): the `#for` iterable surface beyond
// `META.info(T).fields`. Ranges first — `#for i of 0..16`, exclusive end
// like the runtime range-for; the binding is an int VALUE referenced as
// `#i` in expressions and `#{i}` in name templates.

test("comptime ranges drive generated functions and folded expressions", async () => {
	await build_and_check_output(
		`
import System

#for i of 0..4 {
	pub func slot_#{i} = (out int) {
		return #i * 100
	}
}

pub func main = () {
	var total = 0
	#for i of 0..3 {
		total = total + #i
	}
	Console.write_line(total.to_string())
	Console.write_line(slot_2().to_string())
	Console.write_line(slot_0().to_string())
}
`,
		"comptime_range",
		"3\n200\n0\n",
		true,
		{ js: true },
	);
});

test("a comptime-constant condition over the range binding folds", () => {
	const body = `
		func probe = (out string) {
			#for i of 0..3 {
				if #i == 1 {
					return "one"
				}
			}
			return "none"
		}
	`;
	// The arm's `if` folds per iteration: iteration 1 returns "one", the
	// others fold to an empty arm.
	expect(compile_module(body)).toEqual([]);
});

test("an empty range generates nothing (exclusive end)", () => {
	const body = `
		#for i of 5..5 {
			pub func never_#{i} = (out int) { return #i }
		}
		func probe = (out int) {
			return 1
		}
	`;
	expect(compile_module(body)).toEqual([]);
});

test("range bounds must be comptime ints", () => {
	const errors = compile_module(`
		func f = (int n) {
			#for i of 0..n {
				var x = #i
			}
		}
	`);
	expect(errors.some((e) => e.message.includes("needs comptime int bounds"))).toBe(true);
});

test("a range binding is a value — no members, bare use is an error", () => {
	const errors = compile_module(`
		#for i of 0..2 {
			var a = i
		}
	`);
	expect(errors.some((e) => e.message.includes("'#i' is the comptime value"))).toBe(true);
	const member = compile_module(`
		#for i of 0..2 {
			var a = i.name
		}
	`);
	expect(member.some((e) => e.message.includes("value bindings have no members"))).toBe(true);
});
