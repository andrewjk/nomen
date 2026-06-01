import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("memory double free", () => {
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

  func destroy = () {
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

  func destroy = () {
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

  func destroy = () {
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

  func destroy = () {
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
