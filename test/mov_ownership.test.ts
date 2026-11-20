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
  mv Box content
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
  mv Box content
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
  mv Speaker s
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
  mv Speaker s
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
  mv Box content
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
  mv Box content
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
  mv Box content
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
  mv Box content
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

		test("mv string parameter is fine (built-in owner, no library needed)", () => {
			const input = `
func identity = (mv string s, out string) {
  return s
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
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

	// The mv-ownership rule (mv_rule.ts): `mv` is legal only for owning
	// types (the parameter rule's domain — string, class/trait handles, mv
	// structs, type params), enforced at fields, bindings, and stores too.
	describe("mv only on owning types (fields, bindings, stores)", () => {
		test("mv int binding", () => {
			const input = `
mv int x = 5
`;
			const parsed = parse(input);
			// Two rules fire: mv is illegal on a non-owning type, and the
			// initializer is a fresh value no mv could transfer.
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mv is only allowed for class, trait, or mv struct types, not 'int'",
					2,
					1,
				),
				test_error(
					input,
					"'mv' on 'x' transfers nothing — the initializer is a fresh value with no owner to surrender; declare it without 'mv'",
					2,
					12,
				),
			]);
		});

		test("inferred mv binding of an int initializer", () => {
			const input = `
var int y = 6
mv x = y
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mv is only allowed for class, trait, or mv struct types, not 'int'",
					3,
					1,
				),
			]);
		});

		test("mv field of a scalar type", () => {
			const input = `
struct Counter {
  mv int count = 0
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mv is only allowed for class, trait, or mv struct types, not 'int'",
					3,
					3,
				),
			]);
		});

		test("mv store of an int donor", () => {
			const input = `
var int y = 6
var int x = 0
x = mv y
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mv is only allowed for class, trait, or mv struct types, not 'int'",
					4,
					8,
				),
			]);
		});

		test("mv store of a plain (Copyable) struct donor", () => {
			const input = `
struct Point {
  var int x
  var int y
}
var a = Point(1, 2)
var b = Point(0, 0)
b = mv a
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"mv is only allowed for class, trait, or mv struct types, not 'Point'",
					8,
					8,
				),
			]);
		});

		test("mv binding of a declared mv struct is fine", () => {
			const input = `
mv struct Config {
  mv string name
}
var c = Config("x")
mv c2 = c
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("mv field of a declared mv struct type is fine", () => {
			const input = `
mv struct Inner {
  mv string tag
}
mv struct Holder {
  mv Inner inner
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});

	// The ownership-spelling requirement (the flip side of the rule above):
	// an OWNING-typed slot must SPELL `mv`, and a fresh initializer never
	// takes it. Field declarations, field stores, and bindings each enforce
	// their half; type-param slots stay implicit.
	describe("owning slots spell mv (fields, stores, fresh inits)", () => {
		test("a string field without mv errors, naming the spelling", () => {
			const input = `
mv struct Holder {
  var string name
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"field 'name' owns memory — declare it 'mv string name' (plain 'var' is for non-owning types)",
					3,
					3,
				),
			]);
		});

		test("an mv-struct field without mv errors", () => {
			const input = `
mv struct Inner {
  mv string tag
}
mv struct Holder {
  var Inner inner
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"field 'inner' owns memory — declare it 'mv Inner inner' (plain 'var' is for non-owning types)",
					6,
					3,
				),
			]);
		});

		test("a value field without mv is fine; with mv it is the parameter rule's error", () => {
			const input = `
struct Counter {
  var int count
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("a type-param field stays implicit (mv optional, never required)", () => {
			const input = `
mv struct Box<T> {
  var T value
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("a field store of an owned local demands mv on the right-hand side", () => {
			const input = `
mv struct Inner {
  mv string tag = "t"
}
mv struct Holder {
  mv Inner inner
}
var h = Holder(Inner())
var i = Inner()
h.inner = i
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"storing 'i' into owning field 'inner' moves it — write 'inner = mv i' to spell the transfer",
					10,
					11,
				),
			]);
		});

		test("the spelled store transfers: a later read is use-after-mv", () => {
			const input = `
mv struct Holder {
  mv string name
}
var h = Holder("x")
var n = "alice"
h.name = mv n
var copy = n
`;
			const parsed = parse(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0].message).toContain("used after mv");
		});

		test("a fresh store (literal, constructor) never takes mv", () => {
			const input = `
mv struct Holder {
  mv string name
}
var h = Holder("x")
h.name = "alice"
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("mv on a fresh binding initializer errors", () => {
			const input = `
mv n = "bob"
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"'mv' on 'n' transfers nothing — the initializer is a fresh value with no owner to surrender; declare it without 'mv'",
					2,
					8,
				),
			]);
		});

		test("mv on a fresh constructor initializer errors", () => {
			const input = `
mv struct Holder {
  mv string name
}
var h = Holder("x")
mv h2 = Holder("y")
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([
				test_error(
					input,
					"'mv' on 'h2' transfers nothing — the initializer is a fresh value with no owner to surrender; declare it without 'mv'",
					6,
					9,
				),
			]);
		});

		test("mv on a struct field with a fresh initializer is the slot's declaration, not a transfer", () => {
			const input = `
mv struct Node {
  mv string? text = null
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("mv binding from a bare variable is the transfer spelling", () => {
			const input = `
mv struct Config {
  mv string name
}
var c = Config("x")
mv other = c
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});
	});
});
