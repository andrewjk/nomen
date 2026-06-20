import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("memory UAF", () => {
	test("struct with destroy: inner scope assigned to outer var", async () => {
		const input = `
struct Counter {
  var int count

  func #destroy = () {
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

  func #destroy = () {
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

	test("class: inner scope assigned to outer var", async () => {
		const input = `
class Counter {
  var int count

  func #destroy = () {
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

  func #destroy = () {
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
