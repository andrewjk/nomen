import { expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

// docs/SPEC.md, "Type Parameters (`type T`)" — one test per fenced block.

test("a type parameter takes the bare type name at the call site", () => {
	const body = `
		struct Point {
			var x = 0
			var y = 0
		}
		func zero = (type T, out T) {
			var x = T()
			return x
		}
		const int z = zero(int)
		const p = zero(Point)
	`;
	expect(compile_module(body)).toEqual([]);
});

test("reflection composes: META.info(T) and #for inside a type-param function", () => {
	const body = `
		mv struct Sample {
			var count = 0
			var label = ""
		}
		func describe = (type T, out string) {
			var s = META.info(T).name + "("
			#for field of META.info(T).fields {
				s = s + field.name + " "
			}
			return s + ")"
		}
		const names = describe(Sample)
	`;
	expect(compile_module(body)).toEqual([]);
});

test("a non-type argument is rejected at the call", () => {
	const errors = compile_module(`
		func f = (type T, out int) {
			return 0
		}
		const int bad = f("Point")
	`);
	expect(errors.some((e) => e.message.includes("a 'type' parameter takes a bare type name"))).toBe(
		true,
	);
});

// Prose claims: per-specialization folding eliminates dead arms; a generic
// function forwards its parameter as a `type` argument.

test("META.is_struct(T) folds per specialization — the dead arm is never checked", () => {
	const body = `
		func probe = (type T, out string) {
			if META.is_struct(T) {
				return struct_path(T)
			} else {
				return "builtin:" + META.name(T)
			}
		}
		pub func main = () {
			Console.write_line(probe(int))
		}
	`;
	expect(compile_module(body)).toEqual([]);
});

test("a generic parameter forwards as a `type` argument", () => {
	const body = `
		func inner = (type U, out string) {
			return META.info(U).name
		}
		func outer<T> = (T value, out string) {
			return inner(T) + " <- " + META.info(T).name
		}
		pub func main = () {
			Console.write_line(outer(1))
		}
	`;
	expect(compile_module(body)).toEqual([]);
});
