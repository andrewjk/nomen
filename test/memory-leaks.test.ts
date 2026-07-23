import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("memory leaks", () => {
	test("string interpolation frees malloc'd buffer", async () => {
		const input = `
var int x = 42
Console.write("\\{x}")
`;
		await build_and_check_output(input, "leak_interpolate", "42");
	});

	test("int.to_string frees malloc'd buffer", async () => {
		const input = `
var string s = 42.to_string()
Console.write(s)
`;
		await build_and_check_output(input, "leak_to_string", "42");
	});

	test("multiple interpolations free each buffer", async () => {
		const input = `
var int a = 1
var int b = 2
var int c = 3
Console.write("\\{a}")
Console.write("\\{b}")
Console.write("\\{c}")
`;
		await build_and_check_output(input, "leak_multiple_interpolate", "123");
	});

	test("struct destroy frees string fields", async () => {
		const input = `
struct Named {
  var int id
  var string name
}

var int id = 1
var Named n = Named(id, "Alice")
Console.write("\\{n.id}")
`;
		await build_and_check_output(input, "leak_struct_string_field", "1");
	});

	test("inner scope string is freed", async () => {
		const input = `
if 1 == 1 {
  var string s = 42.to_string()
  Console.write(s)
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_scope_string", "42done");
	});

	test("bare string literal does not malloc", async () => {
		const input = `
var int x = 42
Console.write("ok")
`;
		await build_and_check_output(input, "leak_no_leak", "ok");
	});

	test("class interpolation frees malloc'd buffer", async () => {
		const input = `
class Box {
  var int value
}

var Box b = Box(42)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "leak_class_interpolate", "42");
	});

	test("multiple class instances free each allocation", async () => {
		const input = `
class Box {
  var int value
}

var Box a = Box(1)
var Box b = Box(2)
var Box c = Box(3)
Console.write("\\{a.value}")
Console.write("\\{b.value}")
Console.write("\\{c.value}")
`;
		await build_and_check_output(input, "leak_multiple_class", "123");
	});

	test("class destroy frees string fields", async () => {
		const input = `
class Named {
  var int id
  var string name
}

var int id = 1
var Named n = Named(id, "Alice")
Console.write("\\{n.id}")
`;
		await build_and_check_output(input, "leak_class_string_field", "1");
	});

	test("inner scope class is freed", async () => {
		const input = `
class Box {
  var int value
}

if 1 == 1 {
  var Box b = Box(42)
  Console.write("\\{b.value}")
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_scope_class", "42done");
	});

	test("bare string literal does not class malloc", async () => {
		const input = `
var int x = 42
Console.write("ok")
`;
		await build_and_check_output(input, "leak_class_no_leak", "ok");
	});

	test("array of strings from to_string frees each element", async () => {
		const input = `
var parts = Array(1.to_string(), 2.to_string(), 3.to_string())
Console.write("\\{parts.at(0)}")
Console.write("\\{parts.at(1)}")
Console.write("\\{parts.at(2)}")
`;
		await build_and_check_output(input, "leak_array_to_string", "123");
	});

	test("array of classes frees each element", async () => {
		const input = `
class Box {
  var int value
}

var items = Array(Box(1), Box(2), Box(3))
Console.write("\\{items.at(0).value}")
Console.write("\\{items.at(1).value}")
Console.write("\\{items.at(2).value}")
`;
		await build_and_check_output(input, "leak_array_of_classes", "123");
	});

	test("array of classes with destroy frees each element", async () => {
		const input = `
class Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var items = Array(Resource(1), Resource(2))
Console.write("\\{items.at(0).handle}")
Console.write("\\{items.at(1).handle}")
`;
		await build_and_check_output(input, "leak_array_class_destroy", "12");
	});

	test("inner scope array of strings is freed", async () => {
		const input = `
if 1 == 1 {
  var parts = Array(42.to_string(), 99.to_string())
  Console.write("\\{parts.at(0)}")
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_scope_array_strings", "42done");
	});

	test("inner scope array of classes is freed", async () => {
		const input = `
class Box {
  var int value
}

if 1 == 1 {
  var items = Array(Box(10), Box(20))
  Console.write("\\{items.at(0).value}")
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_scope_array_classes", "10done");
	});

	test("for-each over string array frees elements", async () => {
		const input = `
var parts = Array(1.to_string(), 2.to_string())
for s of parts {
  Console.write(s)
}
`;
		await build_and_check_output(input, "leak_foreach_string_array", "12");
	});

	test("for-each over class array frees elements", async () => {
		const input = `
class Box {
  var int value
}

var items = Array(Box(1), Box(2))
for b of items {
  Console.write("\\{b.value}")
}
`;
		await build_and_check_output(input, "leak_foreach_class_array", "12");
	});

	test("break does not leak array string elements in loop", async () => {
		const input = `
var int i = 0
while i < 3 {
  var parts = Array(i.to_string())
  if i == 1 {
    i += 1
    break
  }
  Console.write("\\{parts.at(0)}")
  i += 1
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_break_array_strings", "0done");
	});

	test("break does not leak array class elements in loop", async () => {
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
		await build_and_check_output(input, "leak_break_array_classes", "0done");
	});

	test("continue does not leak array string elements in loop", async () => {
		const input = `
var int i = 0
while i < 3 {
  var parts = Array(i.to_string())
  i += 1
  if i == 2 {
    continue
  }
  Console.write("\\{parts.at(0)}")
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_continue_array_strings", "02done");
	});

	test("continue does not leak array class elements in loop", async () => {
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
		await build_and_check_output(input, "leak_continue_array_classes", "02done");
	});

	test("struct field array of strings frees elements", async () => {
		const input = `
struct Container {
  var Array<string> items
}

var c = Container(Array("hello", "world"))
Console.write("\\{c.items.at(0)}\\{c.items.at(1)}")
`;
		await build_and_check_output(input, "leak_struct_field_string_array", "helloworld");
	});

	test("array of primitives does not heap allocate", async () => {
		const input = `
var nums = Array(1, 2, 3)
Console.write("\\{nums.at(0)}")
Console.write("\\{nums.at(1)}")
Console.write("\\{nums.at(2)}")
`;
		await build_and_check_output(input, "leak_array_primitives", "123");
	});

	// pop() relinquishes the element: the slot is zeroed so the container
	// won't free it, and the popped instance is freed by its own scope.
	test("popped class element is freed", async () => {
		const input = `
class Animal { var char letter }
if true {
	var List<Animal> list = List<Animal>()
	list.push(mov Animal('A'))
	var Animal a = list.pop()
	Console.write("\\{a.letter}")
}
Console.write("done\\n")
`;
		await build_and_check_output(input, "leak_pop_element", "Adone\n");
	});

	// A struct that transitively owns heap resources (here List, via its Buffer
	// field) cannot be byte-copied from another variable — both copies would
	// free the same backing data (double-free). This is rejected at compile
	// time; copy with .copy() or transfer ownership with mov.
	test("struct copy of a container shares the buffer (rejected)", () => {
		const input = `
class Animal { var char letter }
if true {
	var List<Animal> a = List<Animal>()
	a.push(mov Animal('A'))
	var List<Animal> b = a
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("cannot copy 'List'"),
		);
	});

	test("bare class construction (not assigned) is freed", async () => {
		const input = `
class Box {
  var int value
}

Box(42)
Console.write("done")
`;
		await build_and_check_output(input, "leak_bare_class", "done");
	});

	test("bare class construction with destroy (not assigned) is freed", async () => {
		const input = `
class Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

Resource(7)
Console.write("done")
`;
		await build_and_check_output(input, "leak_bare_class_destroy", "done");
	});

	test("bare function call returning a class is freed", async () => {
		const input = `
class Box {
  var int value
}

func make_box = (out Box) {
  return Box(42)
}

make_box()
Console.write("done")
`;
		await build_and_check_output(input, "leak_bare_func_class", "done");
	});

	test("bare method call with owned return is freed", async () => {
		const input = `
class Box {
  var int value
}

var List<Box> list = List<Box>()
list.push(mov Box(1))
list.pop()
Console.write("done")
`;
		await build_and_check_output(input, "leak_bare_method_owned", "done");
	});
});
