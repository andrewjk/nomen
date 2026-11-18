import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { compile_main, compile_module } from "./spec/_helpers.ts";

// `#if`/`#for` at struct/trait-body scope (the Comptime II backlog's stage-3
// item) and declaration generation (stage 6): arms hold members, a `#for`
// generates fields/methods per reflected item, and `$field.name` splices
// the binding's comptime members into member/type names.

test("a struct-body #if selects fields per target", () => {
	const body = `
		pub struct Config {
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
	const other = compile_main(body, { arch: "aarch64", platform: "macos" });
	expect(other.some((e) => e.message.includes("Field not found: c_only"))).toBe(true);
});

test("a struct-body #switch selects methods per target", () => {
	const body = `
		pub struct Gate {
			#switch {
				case META.platform == "macos" {
					pub func open = (self, out string) { return "mac" }
				}
				case META.platform == "linux" {
					pub func open = (self, out string) { return "linux" }
				}
			} else {
				pub func open = (self, out string) { return "generic" }
			}
		}
		func probe = (out string) {
			var g = Gate()
			return g.open()
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
	expect(compile_main(body, { arch: "c", platform: "linux" })).toEqual([]);
});

test("a struct-body #for generates fields via $name splices", async () => {
	await build_and_check_output(
		`
import System

pub struct Pair {
	pub var x = 1
	pub var y = 2
}

pub struct Mirror {
	#for field of META.info(Pair).fields {
		pub var $field.name = 5
	}
}

pub func main = () {
	var m = Mirror()
	Console.write_line("\\{m.x + m.y}")
}
`,
		"comptime_member_fields",
		"10\n",
		true,
		{ js: true },
	);
});

test("a struct-body #for generates methods; Self binds to the conformer", async () => {
	await build_and_check_output(
		`
import System

pub struct Base {
	pub var a = 1
	pub var b = 2
}

pub struct Accessor {
	#for field of META.info(Base).fields {
		pub func get_$field.name = (self, out string) {
			return META.info(Self).name + "." + field.name
		}
	}
	pub var n = 0
}

pub func main = () {
	var acc = Accessor()
	Console.write_line(acc.get_a())
	Console.write_line(acc.get_b())
}
`,
		"comptime_member_methods",
		"Accessor.a\nAccessor.b\n",
		true,
		{ js: true },
	);
});

test("a trait body can carry #if-selected and #for-generated defaults", () => {
	const body = `
		pub struct Base {
			pub var a = 1
		}

		pub trait Features {
			#if META.arch == "c" {
				func c_feature = (self, out int) { return 1 }
			}
			#for field of META.info(Base).fields {
				func count_$field.name = (self, out int) { return 0 }
			}
		}

		pub struct Impl: Features {
			pub var n = 0
		}

		func probe = (Impl i, out int) {
			return i.c_feature() + i.count_a()
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("a generic struct cannot reflect at body scope — loud error", () => {
	const errors = compile_module(`
		pub struct Bad<T> {
			#for field of META.info(T).fields {
				var x = 0
			}
		}
	`);
	expect(errors.some((e) => e.message.includes("META.info: unknown type 'T'"))).toBe(true);
});

test("only fields and methods can be generated at type scope", () => {
	const errors = compile_module(`
		pub struct Base {
			pub var a = 1
		}
		pub struct Bad {
			#for field of META.info(Base).fields {
				Console.write_line(field.name)
			}
		}
	`);
	expect(errors.some((e) => e.message.includes("only fields and methods"))).toBe(true);
});

test("declaration generation: a struct per reflected field, used by name", async () => {
	await build_and_check_output(
		`
import System

pub struct Config {
	pub var int http = 3
	pub var int disk = 4
}

#for field of META.info(Config).fields {
	pub mv struct $field.name: Stringable {
		pub var int value
		pub func tag = (self, out string) {
			return META.info(Self).name
		}
	}
}

pub func main = () {
	var h = http(7)
	var d = disk(9)
	Console.write_line(h.tag())
	Console.write_line(h.to_string())
	Console.write_line("\\{d.value == 9}")
}
`,
		"comptime_declaration_gen",
		"http\nhttp(value=7)\ntrue\n",
		true,
		{ js: true },
	);
});

test("a malformed splice is a compile error", () => {
	const errors = compile_module(`
		pub struct Base {
			pub var a = 1
		}
		pub struct Bad {
			#for field of META.info(Base).fields {
				var $nope.name = 0
			}
		}
	`);
	expect(errors.some((e) => e.message.includes("dotted path over the '#for' binding"))).toBe(true);
});
