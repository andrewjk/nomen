import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";
import type CompileError from "../src/types/CompileError";
import build_and_check_output from "./build_and_check_output";

/** Build the expected error by locating `needle` in `source`. */
function at(source: string, needle: string, message: string): CompileError {
	const start = source.indexOf(needle);
	const before = source.slice(0, start);
	const line = before.split("\n").length;
	const column = start - before.lastIndexOf("\n");
	return { message, start, line, column };
}

describe("readonly fields", () => {
	test("readonly field is readable from outside", () => {
		const input = `
struct Counter {
	readonly count = 7
}
pub func main = () {
	var Counter c = Counter()
	var int n = c.count
}
`;
		expect(parse(input).errors).toEqual([]);
	});

	test("readonly field is not assignable from outside", () => {
		const input = `
struct Counter {
	readonly count = 0
}
pub func main = () {
	var Counter c = Counter()
	c.count = 5
}
`;
		expect(parse(input).errors).toEqual([
			at(input, "count = 5", "Cannot assign to readonly field 'count' from outside Counter"),
		]);
	});

	test("compound assignment to a readonly field from outside is rejected", () => {
		const input = `
struct Counter {
	readonly count = 0
}
pub func main = () {
	var Counter c = Counter()
	c.count += 1
}
`;
		expect(parse(input).errors).toEqual([
			at(input, "count += 1", "Cannot assign to readonly field 'count' from outside Counter"),
		]);
	});

	test("readonly field is assignable inside the declaring struct's methods", () => {
		const input = `
struct Counter {
	readonly count = 0
	func bump = (ref self) {
		self.count = self.count + 1
	}
	func reset = (ref self) {
		self.count = 0
	}
}
`;
		expect(parse(input).errors).toEqual([]);
	});

	test("readonly field is assignable from an extend of the declaring struct", () => {
		const input = `
struct Counter {
	readonly count = 0
}
extend struct Counter {
	func bump = (ref self) {
		self.count = 1
	}
}
`;
		expect(parse(input).errors).toEqual([]);
	});

	test("readonly field is assignable inside a monomorphized method", () => {
		const input = `
struct Box<T> {
	readonly count = 0
	func bump = (ref self) {
		self.count += 1
	}
}
pub func main = () {
	var Box<int> b = Box<int>()
	b.bump()
}
`;
		expect(parse(input).errors).toEqual([]);
	});

	test("another type cannot assign a readonly field", () => {
		const input = `
struct Counter {
	readonly count = 0
}
struct Meddler {
	func clobber = (ref self, ref Counter c) {
		c.count = 9
	}
}
`;
		expect(parse(input).errors).toEqual([
			at(input, "count = 9", "Cannot assign to readonly field 'count' from outside Counter"),
		]);
	});

	test("readonly composes with visibility", () => {
		const input = `
struct Counter {
	internal readonly count = 0
	pub readonly total = 0
}
`;
		expect(parse(input).errors).toEqual([]);
	});

	test("readonly is rejected on locals", () => {
		const input = `
pub func main = () {
	readonly x = 5
}
`;
		expect(parse(input).errors).toEqual([
			at(input, "readonly x", "'readonly' can only be used on a struct or class field"),
		]);
	});

	test("readonly is rejected on trait fields", () => {
		const input = `
trait Sized {
	readonly size = 0
}
`;
		expect(parse(input).errors).toEqual([
			at(input, "readonly size", "'readonly' can only be used on a struct or class field"),
		]);
	});

	test("const field writes are rejected outside the type", () => {
		const input = `
struct Fixed {
	const count = 0
}
pub func main = () {
	var Fixed f = Fixed()
	f.count = 1
}
`;
		expect(parse(input).errors).toEqual([
			at(input, "count = 1", "Cannot assign to const field: count"),
		]);
	});

	test("const field writes are rejected inside the type too", () => {
		const input = `
struct Fixed {
	const count = 0
	func reset = (ref self) {
		self.count = 123
	}
}
`;
		expect(parse(input).errors).toEqual([
			at(input, "count = 123", "Cannot assign to const field: count"),
		]);
	});

	test("readonly field mutated by its own methods runs on both backends", async () => {
		const input = `
struct Counter {
	readonly count = 0
	func bump = (ref self) {
		self.count += 1
	}
	func get = (self, out int) {
		return self.count
	}
}
var Counter c = Counter()
c.bump()
c.bump()
c.bump()
Console.write("\\{c.get()}")
`;
		await build_and_check_output(input, "readonly_field_mutate", "3");
	});
});
