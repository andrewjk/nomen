import { expect, test } from "vite-plus/test";

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

test("attributes attach to structs and fields", () => {
	const body = `
		@sql_table("users")
		mv pub struct User {
			@rename("user_name"), @sql_type("VARCHAR")
			var string user_name
			var int age
			@deprecated
			var string old_field
		}
	`;
	expect(compile_module(body)).toEqual([]);
});

test("META.attr / has_attr drive a generic metadata consumer", () => {
	const body = `
		@sql_table("users")
		mv pub struct User {
			@Name("user_name")
			var string user_name
			var int age
		}
		func keys<T> = (T value, out string) {
			var s = META.info(T).attr("sql_table") + ": "
			#for field of META.info(T).fields {
				if field.has_attr("rename") {
					s = s + field.attr("rename")
				} else {
					s = s + field.name
				}
				s = s + ","
			}
			return s
		}
		pub func main = () {
			Console.write_line(keys(User("jane", 31)))
		}
	`;
	expect(compile_module(body)).toEqual([]);
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

test("conditions compose ints and arithmetic", () => {
	const body = `
		#if META.arch == "c" && 2 + 3 >= 4 {
			Console.write_line("portable path")
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
	expect(compile_main(body, { arch: "aarch64", platform: "macos" })).toEqual([]);
});

test("an #error inside a folded-away arm never fires", () => {
	const body = `
		#if META.arch == "js" {
			#error "this module needs a native target"
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
	expect(compile_main(body, { arch: "aarch64", platform: "macos" })).toEqual([]);
});

test("a live #error fails the compile with its message", () => {
	const errors = compile_module(`#error "Feature X requires a license header"`);
	expect(errors.some((e) => e.message === "Feature X requires a license header")).toBe(true);
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
				Console.write_line("two")
			}
		}
	`;
	expect(compile_module(body)).toEqual([]);
});

test("a type body can gate its own members per target", () => {
	const body = `
		struct Config {
			pub var a = 1
			#if META.arch == "c" {
				pub var c_only = 7
			} else {
				pub var portable = 9
			}
		}
		func probe = (out int) {
			var c = Config()
			return c.c_only
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
	expect(
		compile_main(body, { arch: "aarch64", platform: "macos" }).some((e) =>
			e.message.includes("Field not found: c_only"),
		),
	).toBe(true);
});

test("a struct-body #for generates fields and methods via $ splices", () => {
	const body = `
		pub struct Base {
			pub var a = 1
		}

		pub struct Mirror {
			#for field of META.info(Base).fields {
				pub var #{field.name} = 0
				pub var #{field.name}_count = 0
				pub var #{field.type.name} mirrored
				pub func get_#{field.name} = (self, out string) {
					return META.info(#self).name + "." + field.name
				}
			}
		}

		func probe = (out string) {
			var m = Mirror(0)
			return m.get_a()
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("declaration generation: a struct per reflected field, used by name", () => {
	const body = `
		pub struct Config {
			pub var http = 3
			pub var disk = 4
		}

		#for field of META.info(Config).fields {
			pub mv struct #{field.name}: Stringable {
				pub var int value
				pub func tag = (self, out string) {
					return META.info(#self).name
				}
			}
		}

		func probe = (out string) {
			var h = http(7)
			return h.tag()
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("declaration generation with a literal name prefix", () => {
	const body = `
		pub struct Ids {
			pub var user = 0
		}

		#for field of META.info(Ids).fields {
			pub mv struct id_#{field.name}: Equatable {
				pub var int value
			}
		}

		func probe = (out bool) {
			var u = id_user(3)
			return u == u && u.value == 3
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});
