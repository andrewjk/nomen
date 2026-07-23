import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("memory double free", () => {
	test("assigning heap string to another does not double-free", async () => {
		const input = `
var int x = 1
var int y = 2
var string s = x.to_string()
var string t = y.to_string()
t = s
Console.write(s)
Console.write(t)
`;
		await build_and_check_output(input, "dfree_assign_heap_string", "11");
	});

	test("returning heap string is not use-after-free", async () => {
		const input = `
func make_greeting = (int x, out string) {
  var string s = x.to_string()
  return s
}
var string result = make_greeting(42)
Console.write(result)
`;
		await build_and_check_output(input, "dfree_return_heap_string", "42");
	});

	test("reassigning heap string to literal does not free non-heap pointer", async () => {
		const input = `
var int x = 42
var string s = x.to_string()
s = "literal"
Console.write(s)
`;
		await build_and_check_output(input, "dfree_reassign_to_literal", "literal");
	});

	test("reassigning heap string frees old value", async () => {
		const input = `
var int a = 1
var int b = 2
var string s = a.to_string()
s = b.to_string()
Console.write(s)
`;
		await build_and_check_output(input, "dfree_reassign_leaks_old", "2");
	});

	test("returning string from nested scope does not leak", async () => {
		const input = `
func greet = (int x, out string) {
  var string s = x.to_string()
  if x == 42 {
    return s
  }
  return s
}
var string result = greet(42)
Console.write(result)
`;
		await build_and_check_output(input, "dfree_return_nested_scope", "42");
	});

	test("struct with string field does not leak on destroy", async () => {
		const input = `
struct Named {
  var int id
  var string name
}

var int id = 1
var string name = 42.to_string()
var Named n = Named(id, name)
Console.write("\\{n.id}")
`;
		await build_and_check_output(input, "dfree_struct_string_field", "1");
	});

	test("break does not leak heap string in loop body", async () => {
		const input = `
var int i = 0
while i < 3 {
  var string s = i.to_string()
  if i == 1 {
    i += 1
    break
  }
  Console.write(s)
  i += 1
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_break_heap_string", "0done");
	});

	test("continue does not leak heap string in loop body", async () => {
		const input = `
var int i = 0
while i < 3 {
  var string s = i.to_string()
  i += 1
  if i == 2 {
    continue
  }
  Console.write(s)
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_continue_heap_string", "02done");
	});

	test("aliasing heap string via declaration then reassigning original is not UAF", async () => {
		const input = `
var string a = 42.to_string()
var string b = a
a = "literal"
Console.write(b)
`;
		await build_and_check_output(input, "uaf_alias_then_reassign", "42");
	});

	test("assigning heap string to another variable does not leak old value", async () => {
		const input = `
var string s = 42.to_string()
var string t = s
Console.write(t)
`;
		await build_and_check_output(input, "leak_alias_declaration", "42");
	});

	test("while loop break does not leak heap string", async () => {
		const input = `
var int i = 0
while i < 3 {
  var string s = i.to_string()
  i += 1
  if i == 2 {
    break
  }
  Console.write(s)
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_while_break", "0done");
	});

	test("break runs struct destroy in loop", async () => {
		const input = `
struct Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var int i = 0
while i < 3 {
  var Resource r = Resource(i)
  if i == 1 {
    i += 1
    break
  }
  i += 1
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("bl Resource_destroy");
		expect(result.code.match(/bl Resource_destroy/g)?.length).toBe(2);
		await build_and_check_output(input, "leak_break_struct_destroy", "done");
	});

	test("continue runs struct destroy in loop", async () => {
		const input = `
struct Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var int i = 0
while i < 3 {
  var Resource r = Resource(i)
  i += 1
  if i == 2 {
    continue
  }
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).toContain("bl Resource_destroy");
		expect(result.code.match(/bl Resource_destroy/g)?.length).toBe(2);

		await build_and_check_output(input, "leak_continue_struct_destroy", "done");
	});

	test("assigning class to another does not double-free", async () => {
		const input = `
class Box {
  var int value
}

var Box s = Box(1)
var Box t = Box(2)
t = s
Console.write("\\{s.value}")
Console.write("\\{t.value}")
`;
		await build_and_check_output(input, "dfree_assign_class", "11");
	});

	test("returning class is not use-after-free", async () => {
		const input = `
class Box {
  var int value
}

func make_box = (int x, out Box) {
  var Box b = Box(x)
  return b
}
var Box result = make_box(42)
Console.write("\\{result.value}")
`;
		await build_and_check_output(input, "dfree_return_class", "42");
	});

	test("returning class from nested scope does not leak", async () => {
		const input = `
class Box {
  var int value
}

func get_box = (int x, out Box) {
  var Box b = Box(x)
  if x == 42 {
    return b
  }
  return b
}
var Box result = get_box(42)
Console.write("\\{result.value}")
`;
		await build_and_check_output(input, "dfree_return_nested_class", "42");
	});

	test("reassigning class frees old value", async () => {
		const input = `
class Box {
  var int value
}

var Box s = Box(1)
s = Box(2)
Console.write("\\{s.value}")
`;
		await build_and_check_output(input, "dfree_reassign_class", "2");
	});

	test("returning class from nested scope frees old instance", async () => {
		const input = `
class Box {
  var int value
}

func get_box = (int x, out Box) {
  var Box b = Box(x)
  if x == 42 {
    return b
  }
  return b
}
var Box result = get_box(42)
Console.write("\\{result.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).toContain("bl _nomen_free_wrap");
		expect(result.code).toContain("bl Box_init");

		await build_and_check_output(input, "dfree_class_nested_scope_leaks", "42");
	});

	test("class with string field does not leak on destroy", async () => {
		const input = `
class Named {
  var int id
  var string name
}

var int id = 1
var string name = 42.to_string()
var Named n = Named(id, name)
Console.write("\\{n.id}")
`;
		await build_and_check_output(input, "dfree_class_string_field", "1");
	});

	test("break does not leak class in loop body", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var Box b = Box(i)
  if i == 1 {
    i += 1
    break
  }
  Console.write("\\{b.value}")
  i += 1
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_break_class", "0done");
	});

	test("continue does not leak class in loop body", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var Box b = Box(i)
  i += 1
  if i == 2 {
    continue
  }
  Console.write("\\{b.value}")
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_continue_class", "02done");
	});

	test("aliasing class via declaration then reassigning original is not UAF", async () => {
		const input = `
class Box {
  var int value
}

var Box a = Box(42)
var Box b = a
a = Box(99)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "uaf_class_alias_then_reassign", "42");
	});

	test("assigning class to another variable does not leak old value", async () => {
		const input = `
class Box {
  var int value
}

var Box s = Box(42)
var Box t = s
Console.write("\\{t.value}")
`;
		await build_and_check_output(input, "leak_class_alias_declaration", "42");
	});

	test("while loop break does not leak class", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var Box b = Box(i)
  i += 1
  if i == 2 {
    break
  }
  Console.write("\\{b.value}")
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_while_break_class", "0done");
	});

	test("break runs class destroy in loop", async () => {
		const input = `
class Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var int i = 0
while i < 3 {
  var Resource r = Resource(i)
  if i == 1 {
    i += 1
    break
  }
  i += 1
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).toContain("bl _nomen_free_wrap");
		expect(result.code.match(/bl _nomen_free_wrap/g)?.length).toBe(2);

		await build_and_check_output(input, "leak_break_class_destroy", "done");
	});

	test("continue runs class destroy in loop", async () => {
		const input = `
class Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var int i = 0
while i < 3 {
  var Resource r = Resource(i)
  i += 1
  if i == 2 {
    continue
  }
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).toContain("bl _nomen_free_wrap");
		expect(result.code.match(/bl _nomen_free_wrap/g)?.length).toBe(2);

		await build_and_check_output(input, "leak_continue_class_destroy", "done");
	});

	test("reassigning struct from self method call does not double-free buffer", async () => {
		const input = `
var BigInt k = BigInt()
k = k.new(1)
var BigInt k2 = BigInt()
k2 = k2.new(2)
k = k2.new(3)
var int d = k.to_digit()
Console.write(d.to_string())
`;
		await build_and_check_output(input, "dfree_struct_self_method_reassign", "3");
	});

	test("struct reassignment in loop does not double-free buffer", async () => {
		const input = `
var BigInt k = BigInt()
var int i = 0
while i < 3 {
	k = k.new(i)
	var int d = k.to_digit()
	Console.write(d.to_string())
	i += 1
}
`;
		await build_and_check_output(input, "dfree_struct_loop_reassign", "012");
	});

	test("class field access borrow is not destroyed", async () => {
		const input = `
class Box {
  var int value
}

class Holder {
  mov Box box
}

func get_value = (Holder h, out int) {
  var Box b = h.box
  return b.value
}

var Box box = Box(42)
var Holder h = Holder(mov box)
var int v = get_value(h)
Console.write("\\{v}")
`;
		await build_and_check_output(input, "dfree_class_field_borrowed_ref", "42");
	});
});
