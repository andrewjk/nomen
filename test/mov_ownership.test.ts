import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import test_error from "./test_error";

// STRUCT_PLAN_3 B5 — the field restrictions collapsed into the Copyable
// verifier: a class/trait-typed field (like a declared-mv or Box field)
// owns heap state, so a bare `struct` claiming Copyable is rejected, naming
// the fix. A `mv struct` is the contract — the field is an owned slot.

describe("mv ownership errors", () => {
	describe("mv-typed fields force `mv`", () => {
		test("struct with class field using var", () => {
			const input = `
mv struct Box {
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
					"'Holder' cannot be Copyable — field 'content' owns heap memory --> mark the struct `mv struct Holder`, or remove the field",
					6,
					3,
				),
			]);
		});

		test("struct with class field using mv", () => {
			const input = `
mv struct Box {
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
					"'Holder' cannot be Copyable — field 'content' owns heap memory --> mark the struct `mv struct Holder`, or remove the field",
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
		// STRUCT_PLAN_3 B5: a trait handle is a boxed, mv value (B4), but
		// the FIELD lowering (boxed handle storage + vtable dispatch through
		// the field) is not built yet — the error names the fix. A class with
		// a trait field keeps working (ClassBuffer routing).
		test("struct with trait field using mv", () => {
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
mv struct Holder {
  var Speaker s
}
`;
			const parsed = parse(input);
			expect(
				parsed.errors.some((e) => e.message.includes("a trait-typed field is not supported yet")),
			).toBe(true);
		});
	});

	describe("class-type fields must use mv", () => {
		test("mv struct with var mv field is fine (B5: ownership follows the type)", () => {
			const input = `
mv struct Box {
  var int value
}
mv struct Holder {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("class with mv class field is fine", () => {
			const input = `
mv struct Box {
  var int value
}
mv struct Holder {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("trait with var mv field is fine (B5)", () => {
			const input = `
mv struct Box {
  var int value
}
trait HasBox {
  var Box content
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("trait with mv class field is fine", () => {
			const input = `
mv struct Box {
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
mv struct Counter {
  var int count = 0
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("mv only allowed for class types (or type params)", () => {
		test("mv int parameter", () => {
			const input = `
func identity = (mv int x, out int) {
  return x
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mv is only allowed for class, trait, or mv struct types, not 'int'",
					2,
					18,
				),
			]);
		});

		test("mv struct parameter", () => {
			const input = `
struct Point {
  var int x
  var int y
}
func identity = (mv Point p, out Point) {
  return p
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mv is only allowed for class, trait, or mv struct types, not 'Point'",
					6,
					18,
				),
			]);
		});

		test("mv class parameter is fine", () => {
			const input = `
mv struct Box {
  var int value
}
func identity = (mv Box b, out Box) {
  return b
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("mv string parameter", () => {
			const input = `
func identity = (mv string s, out string) {
  return s
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mv is only allowed for class, trait, or mv struct types, not 'string'",
					2,
					18,
				),
			]);
		});

		test("mv on generic type parameter is allowed", () => {
			const input = `
struct Container<T> {
  var int dummy
  func add = (ref self, mv T value) {
    return
  }
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("mv at call site", () => {
		test("mv with value type at call site to non-mv param", () => {
			const input = `
func identity = (int x, out int) {
  return x
}
var int x = 5
identity(mv x)
`;
			const parsed = parse(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0].message).toContain("mv");
		});
	});
});
