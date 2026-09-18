import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import test_error from "./test_error";

describe("move ownership errors", () => {
	describe("struct fields cannot be class types", () => {
		test("struct with class field using var", () => {
			const input = `
class Box {
  var int value
}
struct Holder {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(input, "struct fields cannot be class types, use a class instead", 6, 3),
			]);
		});

		test("struct with class field using move", () => {
			const input = `
class Box {
  var int value
}
struct Holder {
  move Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(input, "struct fields cannot be class types, use a class instead", 6, 3),
			]);
		});

		test("struct with value type field is fine", () => {
			const input = `
struct Point {
  var int x
  var int y
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("struct fields cannot be trait types", () => {
		// A trait is a reference type (a pointer to a vtable-bearing heap
		// instance), exactly like a class field: it can't be cloned, so a
		// byte-copy of the struct (container store, declaration copy) would
		// share the trait pointer between source and copy — a double-free on
		// destroy. Blocked for the same reason class fields are blocked; use a
		// `class` (routes to ClassBuffer's sound per-pointer destroy) or store
		// the concrete type.
		test("struct with trait field using move", () => {
			const input = `
trait Speaker {
  func say = (out string)
}
struct Holder {
  move Speaker s
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"struct fields cannot be trait types, use a class (or the concrete type) instead",
					6,
					3,
				),
			]);
		});

		test("class with trait field is allowed (ClassBuffer routing)", () => {
			const input = `
trait Speaker {
  func say = (out string)
}
class Holder {
  move Speaker s
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("class-type fields must use move", () => {
		test("class with var class field", () => {
			const input = `
class Box {
  var int value
}
class Holder {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(input, "class-type fields must use 'move', not 'var'", 6, 3),
			]);
		});

		test("class with move class field is fine", () => {
			const input = `
class Box {
  var int value
}
class Holder {
  move Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("trait with var class field", () => {
			const input = `
class Box {
  var int value
}
trait HasBox {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(input, "class-type fields must use 'move', not 'var'", 6, 3),
			]);
		});

		test("trait with move class field is fine", () => {
			const input = `
class Box {
  var int value
}
trait HasBox {
  move Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("class with value type var field is fine", () => {
			const input = `
class Counter {
  var int count = 0
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("move only allowed for class types (or type params)", () => {
		test("move int parameter", () => {
			const input = `
func identity = (move int x, out int) {
  return x
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"move is only allowed for class, trait, or owning struct types, not 'int'",
					2,
					18,
				),
			]);
		});

		test("move struct parameter", () => {
			const input = `
struct Point {
  var int x
  var int y
}
func identity = (move Point p, out Point) {
  return p
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"move is only allowed for class, trait, or owning struct types, not 'Point'",
					6,
					18,
				),
			]);
		});

		test("move class parameter is fine", () => {
			const input = `
class Box {
  var int value
}
func identity = (move Box b, out Box) {
  return b
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("move string parameter", () => {
			const input = `
func identity = (move string s, out string) {
  return s
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"move is only allowed for class, trait, or owning struct types, not 'string'",
					2,
					18,
				),
			]);
		});

		test("move on generic type parameter is allowed", () => {
			const input = `
struct Container<T> {
  var int dummy
  func add = (ref self, move T value) {
    return
  }
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("move at call site", () => {
		test("move with value type at call site to non-move param", () => {
			const input = `
func identity = (int x, out int) {
  return x
}
var int x = 5
identity(move x)
`;
			const parsed = parse(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0].message).toContain("move");
		});
	});
});
