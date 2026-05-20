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
		const result = build(parsed.root, { arch: "aarch64" });
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
		const result = build(parsed.root, { arch: "aarch64" });
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
		await check_output("leak_interpolate", result, "42", { audit: true });
	});

	test("int.to_string leaks malloc'd buffer", async () => {
		const input = `
var string s = 42.to_string()
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_to_string", result, "42", { audit: true });
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
		await check_output("leak_multiple_interpolate", result, "123", { audit: true });
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
		await check_output("leak_struct_string_field", result, "1", { audit: true });
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
		await check_output("leak_scope_string", result, "42done", { audit: true });
	});

	test("no leak: bare string literal (no malloc)", async () => {
		const input = `
var int x = 42
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_no_leak", result, "ok", { audit: true });
	});
});
