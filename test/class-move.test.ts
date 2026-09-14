import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

describe("class ownership transfer (move keyword)", () => {
	test("returning move class param transfers ownership", async () => {
		const input = `
class Box {
  var int value
}

func identity = (move Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = identity(move a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "own_return_param", "42");
	});

	test("returning one of two class params only moves the returned one", async () => {
		const input = `
class Box {
  var int value
}

func pick = (Box a, move Box b, out Box) {
  return b
}

var Box x = Box(1)
var Box y = Box(2)
var Box z = pick(x, move y)
Console.write("\\{x.value}")
Console.write("\\{z.value}")
`;
		await build_and_check_output(input, "own_return_one_of_two", "12");
	});

	test("class param returned through nested function with move", async () => {
		const input = `
class Box {
  var int value
}

func inner = (move Box b, out Box) {
  return b
}

func outer = (move Box b, out Box) {
  return inner(move b)
}

var Box a = Box(42)
var Box result = outer(move a)
Console.write("\\{result.value}")
`;
		await build_and_check_output(input, "own_nested_return", "42");
	});

	test("class param stored in returned array with move", async () => {
		const input = `
class Box {
  var int value
}

func store = (move Box b, out Box[]) {
  var arr = Array(b)
  return arr
}

var Box a = Box(42)
var Box[] result = store(move a)
if result.length > 0 {
  Console.write("\\{result.first().value}")
}
`;
		await build_and_check_output(input, "own_param_in_array", "42");
	});

	test("class in struct field returned from function with move", async () => {
		const input = `
class Box {
  var int value
}

class Holder {
  move Box content
}

func wrap = (move Box b, out Holder) {
  return Holder(move b)
}

var Box a = Box(42)
var Holder h = wrap(move a)
Console.write("\\{h.content.value}")
`;
		await build_and_check_output(input, "own_class_in_struct_field", "42");
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
Console.write("\\{result.first().value}")
`;
		await build_and_check_output(input, "own_stack_array_return", "42");
	});

	test("move at call site requires move in definition", async () => {
		const input = `
class Box {
  var int value
}

func identity = (Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = identity(move a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(2);
		expect(parsed.errors.map((e) => e.message)).toContain(
			"Unexpected 'move' keyword for non-move parameter 'b'",
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
		await build_and_check_output(input, "class_reassign", "2");
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
		await build_and_check_output(input, "class_shared_mutate", "42");
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
		await build_and_check_output(input, "class_if_scope", "42done");
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
		await build_and_check_output(input, "class_destroy_scope", "42done");
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
		await build_and_check_output(input, "class_return_reassign", "4242");
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
		await build_and_check_output(input, "class_array_scope_free", "12done");
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
		await build_and_check_output(input, "class_inner_assign", "2");
	});

	test("class stored in struct field freed with struct", async () => {
		const input = `
class Box {
  var int value
}

class Holder {
  move Box content
}

var Holder h = Holder(move Box(42))
Console.write("\\{h.content.value}")
`;
		await build_and_check_output(input, "class_in_struct_field", "42");
	});

	test("move prevents double-free when class passed to function that returns it", async () => {
		const input = `
class Box {
  var int value
}

func identity = (move Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = identity(move a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "mov_prevents_double_free", "42");
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
		await build_and_check_output(input, "heap_arr_class_scope", "123done");
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
		await build_and_check_output(input, "class_shared_ref", "1010");
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
		await build_and_check_output(input, "foreach_class_free", "123");
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
		await build_and_check_output(input, "break_class_array", "0done");
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
		await build_and_check_output(input, "continue_class_array", "02done");
	});

	test("move with struct (non-class) parameter", () => {
		const input = `
struct Point {
  var int x
  var int y
}

func identity = (move Point p, out Point) {
  return p
}

var Point a = Point(1, 2)
var Point b = identity(move a)
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"move is only allowed for class, trait, or owning struct types, not 'Point'",
				7,
				18,
			),
		]);
	});

	test("multiple move parameters", async () => {
		const input = `
class Box {
  var int value
}

func pick = (move Box a, move Box b, out Box) {
  return b
}

var Box x = Box(1)
var Box y = Box(2)
var Box z = pick(move x, move y)
Console.write("\\{z.value}")
`;
		await build_and_check_output(input, "mov_multiple", "2");
	});

	test("returning class from function without move does not transfer ownership", async () => {
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
		expect(parsed.errors[0].message).toContain("Cannot return class parameter 'b' without 'move'");
	});

	test("returning class param with move is allowed", async () => {
		const input = `
class Box {
  var int value
}

func share = (move Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = share(move a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "mov_class_return", "42");
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
		await build_and_check_output(input, "return_class_local", "42");
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
		expect(parsed.errors[0].message).toContain("Cannot return class parameter 'b' without 'move'");
	});

	test("returning non-class struct param without move is allowed", async () => {
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
		await build_and_check_output(input, "return_struct_param", "1");
	});

	test("returning class param via function call is allowed", async () => {
		const input = `
class Box {
  var int value
}

func identity = (move Box x, out Box) {
  return x
}

func wrap = (move Box b, out Box) {
  return identity(move b)
}

var Box a = Box(42)
var Box b = wrap(move a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "return_class_via_call", "42");
	});

	test("returning a move class param that owns a class field", async () => {
		const input = `
class Box {
  var int v
}
class Holder {
  move Box c
}

func id = (move Holder h, out Holder) {
  return h
}

var Holder a = Holder(move Box(5))
var Holder b = id(move a)
Console.write("\\{b.c.v}")
`;
		await build_and_check_output(input, "return_mov_param_with_field", "5");
	});

	test("moved param is reclaimed when a called method only reads the receiver", async () => {
		const input = `
class Box {
  var int v
  pub func #init = (ref self, int v) {
    self.v = v
  }
  pub func get = (self, out int) {
    return self.v
  }
}
pub func use_it = (move Box b) {
  Console.write_line("\\{b.get()}")
}
pub func take = (move Box b) {
  use_it(move b)
}
var Box box = Box(5)
take(move box)
Console.write_line("done")
`;
		await build_and_check_output(input, "move_param_method_read", "5\ndone");
	});
});
