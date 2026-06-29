import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

describe("class ownership transfer (mov keyword)", () => {
	test("returning mov class param transfers ownership", async () => {
		const input = `
class Box {
  var int value
}

func identity = (mov Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = identity(mov a)
Console.write("\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("own_return_param", result, "42");
	});

	test("returning one of two class params only moves the returned one", async () => {
		const input = `
class Box {
  var int value
}

func pick = (Box a, mov Box b, out Box) {
  return b
}

var Box x = Box(1)
var Box y = Box(2)
var Box z = pick(x, mov y)
Console.write("\\{x.value}")
Console.write("\\{z.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("own_return_one_of_two", result, "12");
	});

	test("class param returned through nested function with mov", async () => {
		const input = `
class Box {
  var int value
}

func inner = (mov Box b, out Box) {
  return b
}

func outer = (mov Box b, out Box) {
  return inner(mov b)
}

var Box a = Box(42)
var Box result = outer(mov a)
Console.write("\\{result.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("own_nested_return", result, "42");
	});

	test("class param stored in returned array with mov", async () => {
		const input = `
class Box {
  var int value
}

func store = (mov Box b, out Box[]) {
  var arr = Array(b)
  return arr
}

var Box a = Box(42)
var Box[] result = store(mov a)
if result.length > 0 {
  Console.write("\\{result.first().value}")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("own_param_in_array", result, "42");
	});

	test("class in struct field returned from function with mov", async () => {
		const input = `
class Box {
  var int value
}

class Holder {
  mov Box content
}

func wrap = (mov Box b, out Holder) {
  return Holder(mov b)
}

var Box a = Box(42)
var Holder h = wrap(mov a)
Console.write("\\{h.content.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("own_class_in_struct_field", result, "42");
	});

	test("class elements in heap-allocated returned arrays (make_arr)", async () => {
		const input = `
class Box {
  var int value
}

func make_arr = (out Box[]) {
  var arr = Array(Box(42))
  return arr
}

var Box[] result = make_arr()
if result.length > 0 {
  Console.write("\\{result.first().value}")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("own_stack_array_return", result, "42");
	});

	test("mov at call site requires mov in definition", async () => {
		const input = `
class Box {
  var int value
}

func identity = (Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = identity(mov a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(2);
		expect(parsed.errors.map((e) => e.message)).toContain(
			"Unexpected 'mov' keyword for non-mov parameter 'b'",
		);
	});

	test("class reassigned to new instance frees old instance", async () => {
		const input = `
class Box {
  var int value
}

var Box a = Box(1)
a = Box(2)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_reassign", result, "2");
	});

	test("class field mutation through shared reference", async () => {
		const input = `
class Box {
  var int value
}

var Box a = Box(1)
var Box b = a
b.value = 42
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_shared_mutate", result, "42");
	});

	test("class in if-scope freed on scope exit", async () => {
		const input = `
class Box {
  var int value
}

if 1 == 1 {
  var Box a = Box(42)
  Console.write("\\{a.value}")
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_if_scope", result, "42done");
	});

	test("destroy block runs on class going out of scope", async () => {
		const input = `
class Resource {
  var int handle

  func #destroy = () {
    self.handle = -1
  }
}

func use = () {
  var Resource r = Resource(42)
  Console.write("\\{r.handle}")
}
use()
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_destroy_scope", result, "42done");
	});

	test("class returned from function and reassigned", async () => {
		const input = `
class Box {
  var int value
}

func make = (out Box) {
  return Box(42)
}

var Box a = make()
Console.write("\\{a.value}")
a = make()
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_return_reassign", result, "4242");
	});

	test("class element in array freed when array goes out of scope", async () => {
		const input = `
class Box {
  var int value
}

if 1 == 1 {
  var items = Array(Box(1), Box(2))
  Console.write("\\{items.at(0).value}\\{items.at(1).value}")
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_array_scope_free", result, "12done");
	});

	test("class assigned in inner scope freed after scope", async () => {
		const input = `
class Box {
  var int value
}

var Box a = Box(1)
if 1 == 1 {
  var Box inner = Box(2)
  a = inner
}
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_inner_assign", result, "2");
	});

	test("class stored in struct field freed with struct", async () => {
		const input = `
class Box {
  var int value
}

class Holder {
  mov Box content
}

var Holder h = Holder(mov Box(42))
Console.write("\\{h.content.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_in_struct_field", result, "42");
	});

	test("mov prevents double-free when class passed to function that returns it", async () => {
		const input = `
class Box {
  var int value
}

func identity = (mov Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = identity(mov a)
Console.write("\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("mov_prevents_double_free", result, "42");
	});

	test("heap-returned array of classes freed at scope exit", async () => {
		const input = `
class Box {
  var int value
}

func make_arr = (out Box[]) {
  var arr = Array(Box(1), Box(2), Box(3))
  return arr
}

if 1 == 1 {
  var Box[] result = make_arr()
  for i of 0 .. result.length {
    Console.write("\\{result.at(i).value}")
  }
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("heap_arr_class_scope", result, "123done");
	});

	test("class used after assignment to another variable shares reference", async () => {
		const input = `
class Box {
  var int value
}

var Box a = Box(10)
var Box b = a
Console.write("\\{a.value}\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("class_shared_ref", result, "1010");
	});

	test("for-each over class array frees elements after loop", async () => {
		const input = `
class Box {
  var int value
}

var items = Array(Box(1), Box(2), Box(3))
for b of items {
  Console.write("\\{b.value}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("foreach_class_free", result, "123");
	});

	test("break in while loop frees class elements in array", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var items = Array(Box(i))
  if i == 1 {
    i += 1
    break
  }
  Console.write("\\{items.at(0).value}")
  i += 1
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("break_class_array", result, "0done");
	});

	test("continue in while loop frees class elements in array", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var items = Array(Box(i))
  i += 1
  if i == 2 {
    continue
  }
  Console.write("\\{items.at(0).value}")
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("continue_class_array", result, "02done");
	});

	test("mov with struct (non-class) parameter", () => {
		const input = `
struct Point {
  var int x
  var int y
}

func identity = (mov Point p, out Point) {
  return p
}

var Point a = Point(1, 2)
var Point b = identity(mov a)
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(input, "mov is only allowed for class types, not 'Point'", 7, 18),
		]);
	});

	test("multiple mov parameters", async () => {
		const input = `
class Box {
  var int value
}

func pick = (mov Box a, mov Box b, out Box) {
  return b
}

var Box x = Box(1)
var Box y = Box(2)
var Box z = pick(mov x, mov y)
Console.write("\\{z.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("mov_multiple", result, "2");
	});

	test("returning class from function without mov does not transfer ownership", async () => {
		const input = `
class Box {
  var int value
}

func share = (Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = share(a)
Console.write("\\{a.value},\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Cannot return class parameter 'b' without 'mov'");
	});

	test("returning class param with mov is allowed", async () => {
		const input = `
class Box {
  var int value
}

func share = (mov Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = share(mov a)
Console.write("\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("mov_class_return", result, "42");
	});

	test("returning class local var is allowed", async () => {
		const input = `
class Box {
  var int value
}

func make = (out Box) {
  var Box a = Box(42)
  return a
}

var Box b = make()
Console.write("\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("return_class_local", result, "42");
	});

	test("returning class param accessed through grouped expression", async () => {
		const input = `
class Box {
  var int value
}

func share = (Box b, out Box) {
  return (b)
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Cannot return class parameter 'b' without 'mov'");
	});

	test("returning non-class struct param without mov is allowed", async () => {
		const input = `
struct Point {
  var int x
  var int y
}

func identity = (Point p, out Point) {
  return p
}

var Point a = Point(1, 2)
var Point b = identity(a)
Console.write("\\{b.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("return_struct_param", result, "1");
	});

	test("returning class param via function call is allowed", async () => {
		const input = `
class Box {
  var int value
}

func identity = (mov Box x, out Box) {
  return x
}

func wrap = (mov Box b, out Box) {
  return identity(mov b)
}

var Box a = Box(42)
var Box b = wrap(mov a)
Console.write("\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("return_class_via_call", result, "42");
	});
});
