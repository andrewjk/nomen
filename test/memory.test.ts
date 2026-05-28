import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("memory UAF", () => {
	test("struct with destroy: inner scope assigned to outer var", async () => {
		const input = `
struct Counter {
  var int count

  destroy = {
    self.count = 0
  }
}

var Counter c = Counter(0)
if 1 == 1 {
  var Counter inner = Counter(5)
  c = inner
}
Console.write("\\{c.count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("uaf_struct_scope", result, "5");
	});

	test("struct alias with destroy copies fields correctly", async () => {
		const input = `
struct Token {
  var int id

  destroy = {
    self.id = 0
  }
}

var Token a = Token(1)
var Token b = a
Console.write("\\{a.id}")
Console.write("\\{b.id}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("uaf_struct_alias", result, "11");
	});
});

describe("memory leaks (aarch64)", () => {
	test("string interpolation leaks malloc'd buffer", async () => {
		const input = `
var int x = 42
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_interpolate", result, "42");
	});

	test("int.to_string leaks malloc'd buffer", async () => {
		const input = `
var string s = 42.to_string()
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_to_string", result, "42");
	});

	test("multiple interpolations leak each buffer", async () => {
		const input = `
var int a = 1
var int b = 2
var int c = 3
Console.write("\\{a}")
Console.write("\\{b}")
Console.write("\\{c}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_multiple_interpolate", result, "123");
	});

	test("struct destroy does not free string fields", async () => {
		const input = `
struct Named {
  var int id
  var string name
}

var int id = 1
var Named n = Named(id, "Alice")
Console.write("\\{n.id}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_struct_string_field", result, "1");
	});

	test("inner scope string is not freed", async () => {
		const input = `
if 1 == 1 {
  var string s = 42.to_string()
  Console.write(s)
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_scope_string", result, "42done");
	});

	test("no leak: bare string literal (no malloc)", async () => {
		const input = `
var int x = 42
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_no_leak", result, "ok");
	});
});

describe("double free (aarch64)", () => {
	test("BUG: assigning heap string to another causes double-free", async () => {
		const input = `
var int x = 1
var int y = 2
var string s = x.to_string()
var string t = y.to_string()
t = s
Console.write(s)
Console.write(t)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_assign_heap_string", result, "11");
	});

	test("BUG: returning heap string is use-after-free", async () => {
		const input = `
func make_greeting = (int x, out string) {
  var string s = x.to_string()
  return s
}
var string result = make_greeting(42)
Console.write(result)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_return_heap_string", result, "42");
	});

	test("BUG: reassigning heap string to literal frees non-heap pointer", async () => {
		const input = `
var int x = 42
var string s = x.to_string()
s = "literal"
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_reassign_to_literal", result, "literal");
	});

	test("BUG: reassigning heap string leaks old value", async () => {
		const input = `
var int a = 1
var int b = 2
var string s = a.to_string()
s = b.to_string()
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_reassign_leaks_old", result, "2");
	});

	test("BUG: returning from nested scope leaks string", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_return_nested_scope", result, "42");
	});

	test("BUG: struct with string field leaks on destroy", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_struct_string_field", result, "1");
	});

	test("BUG: break leaks heap string in loop body", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_break_heap_string", result, "0done");
	});

	test("BUG: continue leaks heap string in loop body", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_continue_heap_string", result, "02done");
	});

	test("BUG: aliasing heap string via declaration then reassigning original is UAF", async () => {
		const input = `
var string a = 42.to_string()
var string b = a
a = "literal"
Console.write(b)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("uaf_alias_then_reassign", result, "42");
	});

	test("BUG: assigning heap string to another variable leaks old value", async () => {
		const input = `
var string s = 42.to_string()
var string t = s
Console.write(t)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_alias_declaration", result, "42");
	});

	test("BUG: while loop break leaks heap string", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_while_break", result, "0done");
	});

	test("BUG: break skips struct destroy in loop", async () => {
		const input = `
struct Resource {
  var int handle

  destroy = {
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
		await check_output("leak_break_struct_destroy", result, "done");
	});

	test("BUG: continue skips struct destroy in loop", async () => {
		const input = `
struct Resource {
  var int handle

  destroy = {
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
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("bl Resource_destroy");
		expect(result.code.match(/bl Resource_destroy/g)?.length).toBe(2);
		await check_output("leak_continue_struct_destroy", result, "done");
	});
});

describe("memory UAF (class)", () => {
	test("class: inner scope assigned to outer var", async () => {
		const input = `
class Counter {
  var int count

  destroy = {
    self.count = 0
  }
}

var Counter c = Counter(0)
if 1 == 1 {
  var Counter inner = Counter(5)
  c = inner
}
Console.write("\\{c.count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("uaf_class_scope", result, "5");
	});

	test("class alias with destroy copies fields correctly", async () => {
		const input = `
class Token {
  var int id

  destroy = {
    self.id = 0
  }
}

var Token a = Token(1)
var Token b = a
Console.write("\\{a.id}")
Console.write("\\{b.id}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("uaf_class_alias", result, "11");
	});
});

describe("memory leaks (class, aarch64)", () => {
	test("class interpolation leaks malloc'd buffer", async () => {
		const input = `
class Box {
  var int value
}

var Box b = Box(42)
Console.write("\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_class_interpolate", result, "42");
	});

	test("multiple class instances leak each allocation", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_multiple_class", result, "123");
	});

	test("class destroy does not free string fields", async () => {
		const input = `
class Named {
  var int id
  var string name
}

var int id = 1
var Named n = Named(id, "Alice")
Console.write("\\{n.id}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_class_string_field", result, "1");
	});

	test("inner scope class is not freed", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_scope_class", result, "42done");
	});

	test("no leak: bare string literal (no class malloc)", async () => {
		const input = `
var int x = 42
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_class_no_leak", result, "ok");
	});
});

describe("double free (class, aarch64)", () => {
	test("BUG: assigning class to another causes double-free", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_assign_class", result, "11");
	});

	test("BUG: returning class is use-after-free", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_return_class", result, "42");
	});

	test("BUG: returning from nested scope leaks class", async () => {
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
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_return_nested_class", result, "42");
	});

	test("BUG: reassigning class leaks old value", async () => {
		const input = `
class Box {
  var int value
}

var Box s = Box(1)
s = Box(2)
Console.write("\\{s.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_reassign_class", result, "2");
	});

	test("BUG: returning from nested scope leaks class", async () => {
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
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("bl _echo_free_wrap");
		expect(result.code).toContain("bl Box_init");
		await check_output("dfree_class_nested_scope_leaks", result, "42");
	});

	test("BUG: class with string field leaks on destroy", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("dfree_class_string_field", result, "1");
	});

	test("BUG: break leaks class in loop body", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_break_class", result, "0done");
	});

	test("BUG: continue leaks class in loop body", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_continue_class", result, "02done");
	});

	test("BUG: aliasing class via declaration then reassigning original is UAF", async () => {
		const input = `
class Box {
  var int value
}

var Box a = Box(42)
var Box b = a
a = Box(99)
Console.write("\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("uaf_class_alias_then_reassign", result, "42");
	});

	test("BUG: assigning class to another variable leaks old value", async () => {
		const input = `
class Box {
  var int value
}

var Box s = Box(42)
var Box t = s
Console.write("\\{t.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_class_alias_declaration", result, "42");
	});

	test("BUG: while loop break leaks class", async () => {
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_while_break_class", result, "0done");
	});

	test("BUG: break skips class destroy in loop", async () => {
		const input = `
class Resource {
  var int handle

  destroy = {
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
		expect(result.code).toContain("bl _echo_free_wrap");
		expect(result.code.match(/bl _echo_free_wrap/g)?.length).toBe(2);
		await check_output("leak_break_class_destroy", result, "done");
	});

	test("BUG: continue skips class destroy in loop", async () => {
		const input = `
class Resource {
  var int handle

  destroy = {
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
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("bl _echo_free_wrap");
		expect(result.code.match(/bl _echo_free_wrap/g)?.length).toBe(2);
		await check_output("leak_continue_class_destroy", result, "done");
	});
});

describe("memory leaks (arrays of heap types, aarch64)", () => {
	test("BUG: array of strings from to_string leaks each element", async () => {
		const input = `
var string[] parts = [1.to_string(), 2.to_string(), 3.to_string()]
Console.write("\\{parts[0]}")
Console.write("\\{parts[1]}")
Console.write("\\{parts[2]}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_array_to_string", result, "123");
	});

	test("array of classes leaks each element", async () => {
		const input = `
class Box {
  var int value
}

var Box[] items = [Box(1), Box(2), Box(3)]
Console.write("\\{items[0].value}")
Console.write("\\{items[1].value}")
Console.write("\\{items[2].value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_array_of_classes", result, "123");
	});

	test("array of classes with destroy leaks each element", async () => {
		const input = `
class Resource {
  var int handle

  destroy = {
    self.handle = -1
  }
}

var Resource[] items = [Resource(1), Resource(2)]
Console.write("\\{items[0].handle}")
Console.write("\\{items[1].handle}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_array_class_destroy", result, "12");
	});

	test("BUG: inner scope array of strings leaks", async () => {
		const input = `
if 1 == 1 {
  var string[] parts = [42.to_string(), 99.to_string()]
  Console.write("\\{parts[0]}")
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_scope_array_strings", result, "42done");
	});

	test("inner scope array of classes leaks", async () => {
		const input = `
class Box {
  var int value
}

if 1 == 1 {
  var Box[] items = [Box(10), Box(20)]
  Console.write("\\{items[0].value}")
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_scope_array_classes", result, "10done");
	});

	test("BUG: for-each over string array leaks elements", async () => {
		const input = `
var string[] parts = [1.to_string(), 2.to_string()]
for s of parts {
  Console.write(s)
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_foreach_string_array", result, "12");
	});

	test("for-each over class array leaks elements", async () => {
		const input = `
class Box {
  var int value
}

var Box[] items = [Box(1), Box(2)]
for b of items {
  Console.write("\\{b.value}")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_foreach_class_array", result, "12");
	});

	test("BUG: break leaks array string elements in loop", async () => {
		const input = `
var int i = 0
while i < 3 {
  var string[] parts = [i.to_string()]
  if i == 1 {
    i += 1
    break
  }
  Console.write("\\{parts[0]}")
  i += 1
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_break_array_strings", result, "0done");
	});

	test("BUG: break leaks array class elements in loop", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var Box[] items = [Box(i)]
  if i == 1 {
    i += 1
    break
  }
  Console.write("\\{items[0].value}")
  i += 1
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_break_array_classes", result, "0done");
	});

	test("BUG: continue leaks array string elements in loop", async () => {
		const input = `
var int i = 0
while i < 3 {
  var string[] parts = [i.to_string()]
  i += 1
  if i == 2 {
    continue
  }
  Console.write("\\{parts[0]}")
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_continue_array_strings", result, "02done");
	});

	test("BUG: continue leaks array class elements in loop", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var Box[] items = [Box(i)]
  i += 1
  if i == 2 {
    continue
  }
  Console.write("\\{items[0].value}")
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_continue_array_classes", result, "02done");
	});

	test("BUG: struct field array of strings leaks elements", async () => {
		const input = `
struct Container {
  var string[] items
}

var c = Container(["hello", "world"])
Console.write("\\{c.items[0]}\\{c.items[1]}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_struct_field_string_array", result, "helloworld");
	});

	test("no leak: array of primitives (no heap allocation)", async () => {
		const input = `
var int[] nums = [1, 2, 3]
Console.write("\\{nums[0]}")
Console.write("\\{nums[1]}")
Console.write("\\{nums[2]}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_array_primitives", result, "123");
	});
});

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
  var Box[] arr = [b]
  return arr
}

var Box a = Box(42)
var Box[] result = store(mov a)
Console.write("\\{result[0].value}")
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

struct Holder {
  var Box content
}

func wrap = (mov Box b, out Holder) {
  return Holder(b)
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
  var Box[] arr = [Box(42)]
  return arr
}

var Box[] result = make_arr()
Console.write("\\{result[0].value}")
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
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Unexpected 'mov' keyword");
	});

	test("mov in definition requires mov at call site", async () => {
		const input = `
class Box {
  var int value
}

func identity = (mov Box b, out Box) {
  return b
}

var Box a = Box(42)
var Box b = identity(a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Missing 'mov' keyword");
	});
});
