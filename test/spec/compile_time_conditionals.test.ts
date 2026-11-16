import { expect, test } from "vitest";

import { compile_main, compile_module } from "./_helpers.ts";

// SPEC.md, "Compile-Time Conditionals" — one test per fenced code block.
// Every block pins its compile target explicitly so the fold is
// deterministic regardless of host.

test("#switch selects the matching arm per target", () => {
	const body = `
		#switch {
			case META.arch == "aarch64" -> Console.write_line("arm")
			case META.arch == "c" { Console.write_line("c target") }
		} else {
			Console.write_line("other")
		}
	`;
	expect(compile_main(body, { arch: "aarch64", platform: "macos" })).toEqual([]);
	expect(compile_main(body, { arch: "c", platform: "linux" })).toEqual([]);
});

test("#for unrolls per field — the binding drives names, reads and writes", () => {
	const body = `
		mv struct Counter {
			var int n
			var string label
		}
		func zero_ints = (mv Counter c, mv out Counter) {
			#for field of META.info(Counter).fields {
				if field.type.name == "int" {
					field.set(c, 0)
				}
			}
			return c
		}
	`;
	expect(compile_module(body)).toEqual([]);
});

test("#for defers in a generic body and expands at specialization", () => {
	const body = `
		struct Point {
			var int x
			var int y
		}
		func describe<T> = (T value, out string) {
			var s = META.info(T).name + "("
			#for field of META.info(T).fields {
				s = s + field.name + " "
			}
			s = s + ")"
			return s
		}
		pub func main = () {
			Console.write_line(describe(Point(1, 2)))
		}
	`;
	expect(compile_module(body)).toEqual([]);
});

test("META.info over an unknown type errors at the loop", () => {
	const errors = compile_module(`
		func f = () {
			#for field of META.info(Nope).fields {
				var x = 1
			}
		}
	`);
	expect(errors.some((e) => e.message.includes("META.info: unknown type 'Nope'"))).toBe(true);
});

test("#if with a bare else mirrors the runtime if", () => {
	const body = `
		#if META.arch == "c" {
			Console.write_line("portable path")
		} else {
			Console.write_line("not c")
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
	expect(compile_main(body, { arch: "aarch64", platform: "macos" })).toEqual([]);
});

test("equality against a target constant compiles clean", () => {
	expect(
		compile_main(`#if META.arch == "c" { Console.write_line("portable path") }`, {
			arch: "c",
			platform: "macos",
		}),
	).toEqual([]);
});

test("conditions are bools — a bare META value is an error", () => {
	const errors = compile_main(`#if META.arch { }`, { arch: "c", platform: "macos" });
	expect(
		errors.some((e) =>
			e.message.includes(`#if condition must be a bool — compare META values with == / !=`),
		),
	).toBe(true);
});

test("declaration scope: a whole struct is selected per platform", () => {
	const body = `
		#if META.platform == "macos" {
			struct MacOnly {
				pub func hello = (self, out string) {
					return "mac"
				}
			}
		}
	`;
	expect(compile_module(body, { arch: "c", platform: "macos" })).toEqual([]);
	expect(compile_module(body, { arch: "c", platform: "linux" })).toEqual([]);
});

test("a function body may switch implementation per target", () => {
	const body = `
		func clamp8 = (int v, out int) {
			#if META.arch == "aarch64" {
				return v
			} else {
				if v < 0 { return 0 }
				if v > 255 { return 255 }
				return v
			}
		}
	`;
	expect(compile_module(body, { arch: "aarch64", platform: "macos" })).toEqual([]);
	expect(compile_module(body, { arch: "c", platform: "macos" })).toEqual([]);
});
