import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import test_error from "./test_error";

describe("mov ownership errors", () => {
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

		test("struct with class field using mov", () => {
			const input = `
class Box {
  var int value
}
struct Holder {
  mov Box content
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
		test("struct with trait field using mov", () => {
			const input = `
trait Speaker {
  func say = (out string)
}
struct Holder {
  mov Speaker s
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
  mov Speaker s
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("class-type fields must use mov", () => {
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
				test_error(input, "class-type fields must use 'mov', not 'var'", 6, 3),
			]);
		});

		test("class with mov class field is fine", () => {
			const input = `
class Box {
  var int value
}
class Holder {
  mov Box content
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
				test_error(input, "class-type fields must use 'mov', not 'var'", 6, 3),
			]);
		});

		test("trait with mov class field is fine", () => {
			const input = `
class Box {
  var int value
}
trait HasBox {
  mov Box content
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

	describe("mov only allowed for class types (or type params)", () => {
		test("mov int parameter", () => {
			const input = `
func identity = (mov int x, out int) {
  return x
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(input, "mov is only allowed for class or owning struct types, not 'int'", 2, 18),
			]);
		});

		test("mov struct parameter", () => {
			const input = `
struct Point {
  var int x
  var int y
}
func identity = (mov Point p, out Point) {
  return p
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mov is only allowed for class or owning struct types, not 'Point'",
					6,
					18,
				),
			]);
		});

		test("mov class parameter is fine", () => {
			const input = `
class Box {
  var int value
}
func identity = (mov Box b, out Box) {
  return b
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("mov string parameter", () => {
			const input = `
func identity = (mov string s, out string) {
  return s
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mov is only allowed for class or owning struct types, not 'string'",
					2,
					18,
				),
			]);
		});

		test("mov on generic type parameter is allowed", () => {
			const input = `
struct Container<T> {
  var int dummy
  func add = (ref self, mov T value) {
    return
  }
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("mov at call site", () => {
		test("mov with value type at call site to non-mov param", () => {
			const input = `
func identity = (int x, out int) {
  return x
}
var int x = 5
identity(mov x)
`;
			const parsed = parse(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0].message).toContain("mov");
		});
	});
});
