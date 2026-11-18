import { expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./spec/_helpers.ts";

// Comptime integers + arithmetic + the user `#error` directive (the
// Comptime II backlog item 1). The `#if`/`#switch` condition grammar gains
// int literals, `+ - * / %` arithmetic and `< <= > >=` comparisons;
// `META.info(T).field_count` exposes a comptime int; `#error "message"` is
// a live-arm compile error the `#if` fold can gate.

test("#if folds int arithmetic and comparisons", () => {
	const body = `
		#if 2 * 3 + 1 > 6 {
			Console.write_line("arm")
		} else {
			nonexistent_dead()
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("#switch case arms take int conditions", () => {
	const body = `
		#switch {
			case META.arch == "aarch64" && 1 + 1 == 3 -> nonexistent_dead()
			case META.platform == "macos" -> Console.write_line("mac")
			case 10 % 3 == 2 { Console.write_line("also true but unreachable") }
		} else {
			nonexistent_dead_too()
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("comptime division by zero is a compile error", () => {
	const errors = compile_main(`#if 1 / 0 == 0 { }`, { arch: "c", platform: "macos" });
	expect(errors.some((e) => e.message.includes("compile-time division by zero"))).toBe(true);
	const mod = compile_main(`#if 5 % 0 == 0 { }`, { arch: "c", platform: "macos" });
	expect(mod.some((e) => e.message.includes("compile-time division by zero"))).toBe(true);
});

test("int/string cross-kind comparison is an error", () => {
	const errors = compile_main(`#if 1 == "a" { }`, { arch: "c", platform: "macos" });
	expect(errors.some((e) => e.message.includes("compares an int with a string"))).toBe(true);
});

test("ordering comparisons need int operands", () => {
	const errors = compile_main(`#if "a" < "b" { }`, { arch: "c", platform: "macos" });
	expect(errors.some((e) => e.message.includes("'<' in a #if condition needs int operands"))).toBe(
		true,
	);
});

test("unary minus folds in a condition", () => {
	const body = `
		#if -(2 + 3) == -5 {
			Console.write_line("arm")
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("#error fires when the statement walk reaches it", () => {
	const errors = compile_module(`#error "Feature X needs the C backend"`);
	expect(errors.length).toBe(1);
	expect(errors[0].message).toBe("Feature X needs the C backend");
});

test("#error inside a dead #if arm never fires", () => {
	const body = `
		#if META.arch == "js" {
			#error "this module needs a native target"
		}
		func f = () {
			#if 1 == 2 {
				#error "unreachable"
			}
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("#error inside a live #if arm fires with the message", () => {
	const errors = compile_main(`#if META.arch == "c" { #error "no C support for this module" }`, {
		arch: "c",
		platform: "macos",
	});
	expect(errors.some((e) => e.message === "no C support for this module")).toBe(true);
});

test("#error takes a string literal", () => {
	const errors = compile_module(`#error 42`);
	expect(errors.some((e) => e.message.includes(`#error takes a string literal`))).toBe(true);
});

test("META.info(T).field_count is a comptime int", () => {
	const body = `
		struct Point {
			var int x
			var int y
		}
		func probe = () {
			var n = META.info(Point).field_count
			if n == 2 {
				Console.write_line("two fields")
			}
		}
	`;
	// The value rewrites to an int literal per block (rewrite_meta_name_chains);
	// the `if` stays a runtime test on the literal — it compiles clean.
	expect(compile_module(body)).toEqual([]);
});

test("field_count drives per-field dispatch inside #for arms", () => {
	const body = `
		struct Single {
			var int only
		}
		func f = () {
			#for field of META.info(Single).fields {
				if META.info(Single).field_count == 1 {
					Console.write_line(field.name)
				} else {
					nonexistent_dead()
				}
			}
		}
	`;
	expect(compile_module(body)).toEqual([]);
});
