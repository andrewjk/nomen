import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build.ts";
import build_js from "../src/build_js/build_js.ts";
import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function parse_src(source: string, options?: { arch?: string; platform?: string }) {
	return parse(`import System\n${source}`, system, undefined, {
		allow_internal: true,
		...options,
	});
}

test("concrete T expands at check time — the loop compiles per field", () => {
	const parsed = parse_src(`
		struct Point {
			var int x
			var int y
		}
		func probe = () {
			#for field of META.info(Point).fields {
				Console.write_line(field.name)
			}
		}
	`);
	expect(parsed.errors).toEqual([]);
});

test("deferred in a generic body, expanded at specialization", () => {
	const parsed = parse_src(`
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
	`);
	expect(parsed.errors).toEqual([]);
});

test("comptime field dispatch folds the int/string arms", () => {
	const parsed = parse_src(`
		mv struct Counter {
			var int n
			var string label
		}
		func reset_ints = (mv Counter c, mv out Counter) {
			#for field of META.info(Counter).fields {
				if field.type.name == "int" {
					field.set(c, 0)
				}
			}
			return c
		}
	`);
	expect(parsed.errors).toEqual([]);
});

test("field.set outside statement position is an error", () => {
	const parsed = parse_src(`
		struct Boxed {
			var int n
		}
		func f = (Boxed b, out int) {
			#for field of META.info(Boxed).fields {
				var x = field.set(b, 1)
			}
			return 0
		}
	`);
	expect(
		parsed.errors.some((e) => e.message.includes(".set(obj, value)' must be a statement")),
	).toBe(true);
});

test("bare binding use is an error", () => {
	const parsed = parse_src(`
		struct Boxed {
			var int n
		}
		func f = () {
			#for field of META.info(Boxed).fields {
				Console.write_line(field)
			}
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("used without .name, .get or .set"))).toBe(
		true,
	);
});

test("unknown comptime member is an error", () => {
	const parsed = parse_src(`
		struct Boxed {
			var int n
		}
		func f = () {
			#for field of META.info(Boxed).fields {
				Console.write_line(field.offset)
			}
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("supports .name"))).toBe(true);
});

test("unknown type in META.info errors loudly", () => {
	const parsed = parse_src(`
		func f = () {
			#for field of META.info(Nope).fields {
				var x = 1
			}
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("META.info: unknown type 'Nope'"))).toBe(
		true,
	);
});

test("META.info over a generic type errors — reflect over a concrete instantiation", () => {
	const parsed = parse_src(`
		struct Holder<T> {
			var int n
		}
		func f = () {
			#for field of META.info(Holder).fields {
				var x = 1
			}
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("is generic"))).toBe(true);
});

test("unresolvable T in a never-specialized generic is left deferred, not an error", () => {
	const parsed = parse_src(`
		struct Point {
			var int x
		}
		func describe<T> = (T value, out string) {
			#for field of META.info(T).fields {
				Console.write_line(field.name)
			}
			return ""
		}
	`);
	// The body is deferred; no call site, so nothing specializes. No error
	// and no phantom expansion — the loop simply never ran.
	expect(parsed.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// R9 acceptance (docs/COMPTIME_PLAN_2.md): re-derive Stringable / Equatable /
// Hashable with `#for field of META.info(T).fields` and diff the behavior
// against the hardcoded derives. Run through the JS backend (in-process,
// deterministic) and build clean through the C backend.
// ---------------------------------------------------------------------------

const ACCEPTANCE_SOURCE = `
import System

mv struct Sample: Stringable, Equatable, Hashable {
	var int count
	var string label
}

struct Ints: Hashable {
	var int a
	var int b
}

func manual_to_string<T> = (T value, out string) {
	var s = META.info(T).name + "("
	var first = true
	#for field of META.info(T).fields {
		if !first {
			s = s + ", "
		}
		first = false
		s = s + field.name + "=" + field.get(value).to_string()
	}
	s = s + ")"
	return s
}

func manual_eq<T> = (T a, T b, out bool) {
	var result = true
	#for field of META.info(T).fields {
		result = result && field.get(a) == field.get(b)
	}
	return result
}

func manual_hash<T> = (T value, out uint) {
	var uint acc = 0
	#for field of META.info(T).fields {
		acc = acc * 31 + (field.get(value) as uint)
	}
	return acc
}

pub func main = () {
	var a = Sample(7, "hi")
	var b = Sample(7, "hi")
	var c = Sample(8, "ho")
	Console.write_line(a.to_string())
	Console.write_line(manual_to_string(a))
	Console.write_line("\\{a == b}")
	Console.write_line("\\{a == c}")
	Console.write_line("\\{manual_eq(a, b)}")
	Console.write_line("\\{manual_eq(a, c)}")
	var i = Ints(3, 4)
	Console.write_line("\\{i.hash() == manual_hash(i)}")
}
`;

test("R9: the #for-based derives match the hardcoded derives at runtime", () => {
	const parsed = parse_src(ACCEPTANCE_SOURCE);
	expect(parsed.errors).toEqual([]);

	const js = build_js(parsed.root, { target: "node" });
	expect(js.errors ?? []).toEqual([]);

	// Run from an OS temp dir — test/out stays free of per-test artifacts.
	const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "comptime-for-")), "r9.mjs");
	fs.writeFileSync(outfile, js.code);
	const stdout = execFileSync(process.execPath, [outfile], { encoding: "utf8" });
	const lines = stdout.trim().split("\n");
	// to_string: the manual generic reproduces the derive byte-for-byte.
	expect(lines[1]).toBe(lines[0]);
	expect(lines[0]).toBe("Sample(count=7, label=hi)");
	// eq: builtin `==` and the manual fold agree on equal and unequal pairs.
	expect(lines[2]).toBe("true");
	expect(lines[3]).toBe("false");
	expect(lines[4]).toBe("true");
	expect(lines[5]).toBe("false");
	// hash: the manual accumulator fold matches the derive's hash exactly.
	expect(lines[6]).toBe("true");
});

test("R9: the C backend builds the expanded program clean", () => {
	const parsed = parse_src(ACCEPTANCE_SOURCE, { arch: "c", platform: "linux" });
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "c", platform: "linux" });
	expect(built.errors ?? []).toEqual([]);
});

test("field.type.args exposes container element types for dispatch", () => {
	const parsed = parse_src(`
		mv struct Item {
			var int n = 0
		}
		mv struct Holder {
			var items = StableList<Item>()
			var floats = StableList<float>()
			var name = ""
		}
		func probe = () {
			#for field of META.info(Holder).fields {
				if field.type.arg_count > 0 {
					if field.type.args[0] == "Item" {
						Console.write_line(field.name + " is an Item list")
					}
					if field.type.args[0] == "float" {
						Console.write_line(field.name + " is a float list")
					}
				} else {
					Console.write_line(field.name + " has no type args")
				}
			}
		}
	`);
	expect(parsed.errors).toEqual([]);
});

test("field.type.args out of range is an error", () => {
	const parsed = parse_src(`
		struct Plain {
			var name = ""
		}
		func probe = () {
			#for field of META.info(Plain).fields {
				Console.write_line(field.type.args[0])
			}
		}
	`);
	expect(
		parsed.errors.some((e) => e.message.includes("out of range — type 'string' has 0 argument(s)")),
	).toBe(true);
});

test("field.type.args needs a comptime index", () => {
	const parsed = parse_src(`
		mv struct Holder {
			var items = StableList<int>()
		}
		func probe = (int i) {
			#for field of META.info(Holder).fields {
				Console.write_line(field.type.args[i])
			}
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("needs a comptime int index"))).toBe(true);
});

test("field.type.args nests recursively — args[0].args[0], .name, .arg_count", () => {
	// The `else` arms call a nonexistent function: any error means a fold
	// failed to eliminate the dead branch.
	const parsed = parse_src(`
		mv struct Leaf2 {
			var int x = 0
		}
		mv struct Nest2 {
			var grid = StableList<StableList<Leaf2>>()
			var plain = StableList<float>()
		}
		func probe = () {
			#for field of META.info(Nest2).fields {
				if field.type.arg_count > 0 {
					if field.type.args[0].arg_count > 0 {
						if field.type.args[0].args[0] == "Leaf2" {
							Console.write_line(field.name + ": nested Leaf2")
						} else {
							nonexistent_a()
						}
						if field.type.args[0].name == "StableList" {
							Console.write_line(field.name + ": outer StableList")
						} else {
							nonexistent_b()
						}
					} else {
						if field.type.args[0] == "float" {
							Console.write_line(field.name + ": floats")
						} else {
							nonexistent_c()
						}
					}
				} else {
					nonexistent_d()
				}
			}
		}
	`);
	expect(parsed.errors).toEqual([]);
});

test("reflection over a MONO struct keeps type args", () => {
	const parsed = parse_src(`
		mv struct Holder2<T> {
			var items = StableList<T>()
			var n = 0
		}
		func probe = () {
			var h = Holder2<int>()
			#for field of META.info(Holder2_int).fields {
				if field.type.arg_count > 0 {
					if field.type.args[0] == "int" {
						Console.write_line(field.name + ": int args")
					} else {
						nonexistent_e()
					}
				} else {
					if field.name == "items" {
						nonexistent_f()
					}
				}
			}
		}
	`);
	expect(parsed.errors).toEqual([]);
});
