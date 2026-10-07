import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import test_error from "./test_error";

// STRUCT_PLAN_3 B5 — the field restrictions collapsed into the Copyable
// verifier: a class/trait-typed field (like a declared-owning or Box field)
// owns heap state, so a bare `struct` claiming Copyable is rejected, naming
// the fix. An `owning struct` is the contract — the field is an owned slot.

describe("move ownership errors", () => {
	describe("owning-typed fields force `owning`", () => {
		test("struct with class field using var", () => {
			const input = `
owning struct Box {
  var int value
}
struct Holder {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"'Holder' cannot be Copyable — field 'content' owns heap memory --> mark the struct `owning struct Holder`, or remove the field",
					6,
					3,
				),
			]);
		});

		test("struct with class field using move", () => {
			const input = `
owning struct Box {
  var int value
}
struct Holder {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"'Holder' cannot be Copyable — field 'content' owns heap memory --> mark the struct `owning struct Holder`, or remove the field",
					6,
					3,
				),
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

	describe("trait-typed fields are not supported yet", () => {
		// STRUCT_PLAN_3 B5: a trait handle is a boxed, owning value (B4), but
		// the FIELD lowering (boxed handle storage + vtable dispatch through
		// the field) is not built yet — the error names the fix. A class with
		// a trait field keeps working (ClassBuffer routing).
		test("struct with trait field using move", () => {
			const input = `
trait Speaker {
  func say = (out string)
}
struct Holder {
  var Speaker s
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"a trait-typed field is not supported yet — declare 's' with the concrete type, or `Box<Speaker>` once boxed",
					6,
					3,
				),
			]);
		});

		test("trait-typed field is rejected (B5: boxed-handle field lowering is future work)", () => {
			const input = `
trait Speaker {
  func say = (out string)
}
owning struct Holder {
  var Speaker s
}
`;
			const parsed = parse(input);
			expect(
				parsed.errors.some((e) => e.message.includes("a trait-typed field is not supported yet")),
			).toBe(true);
		});
	});

	describe("class-type fields must use move", () => {
		test("owning struct with var owning field is fine (B5: ownership follows the type)", () => {
			const input = `
owning struct Box {
  var int value
}
owning struct Holder {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("class with move class field is fine", () => {
			const input = `
owning struct Box {
  var int value
}
owning struct Holder {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("trait with var owning field is fine (B5)", () => {
			const input = `
owning struct Box {
  var int value
}
trait HasBox {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("trait with move class field is fine", () => {
			const input = `
owning struct Box {
  var int value
}
trait HasBox {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("class with value type var field is fine", () => {
			const input = `
owning struct Counter {
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
owning struct Box {
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
