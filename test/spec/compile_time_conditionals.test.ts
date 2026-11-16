import { expect, test } from "vitest";

import { compile_main, compile_module } from "./_helpers.ts";

// SPEC.md, "Compile-Time Conditionals" — one test per fenced code block.
// Every block pins its compile target explicitly so the fold is
// deterministic regardless of the host running the suite.

test("body-scope arch switch selects the matching arm", () => {
	const body = `
		#if META.arch == "aarch64" {
			Console.write_line("arm")
		} #elif META.arch == "c" {
			Console.write_line("c target")
		} #else {
			Console.write_line("other")
		}
	`;
	expect(compile_main(body, { arch: "aarch64", platform: "macos" })).toEqual([]);
	expect(compile_main(body, { arch: "c", platform: "linux" })).toEqual([]);
});

test("conditions are bools — a bare META value is an error", () => {
	const errors = compile_main(`#if META.arch { }`, { arch: "c", platform: "macos" });
	expect(
		errors.some((e) =>
			e.message.includes(`#if condition must be a bool — compare META values with == / !=`),
		),
	).toBe(true);
});

test("equality against a target constant compiles clean", () => {
	expect(
		compile_main(`#if META.arch == "c" { Console.write_line("portable path") }`, {
			arch: "c",
			platform: "macos",
		}),
	).toEqual([]);
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
			} #else {
				if v < 0 { return 0 }
				if v > 255 { return 255 }
				return v
			}
		}
	`;
	expect(compile_module(body, { arch: "aarch64", platform: "macos" })).toEqual([]);
	expect(compile_module(body, { arch: "c", platform: "macos" })).toEqual([]);
});
