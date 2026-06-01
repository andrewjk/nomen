import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("memory leaks", () => {
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

  func destroy = () {
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
