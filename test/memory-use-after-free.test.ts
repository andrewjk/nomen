import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("memory UAF", () => {
	test("struct with destroy: inner scope assigned to outer var", async () => {
		const input = `
struct Counter {
  var int count

  func #destroy = (ref self) {
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
		await build_and_check_output(input, "uaf_struct_scope", "5");
	});

	test("struct alias with destroy copies fields correctly", async () => {
		const input = `
struct Token {
  var int id

  func #destroy = (ref self) {
    self.id = 0
  }
}

var Token a = Token(1)
var Token b = a
Console.write("\\{a.id}")
Console.write("\\{b.id}")
`;
		await build_and_check_output(input, "uaf_struct_alias", "11");
	});

	test("class: inner scope assigned to outer var", async () => {
		const input = `
class Counter {
  var int count

  func #destroy = (ref self) {
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
		await build_and_check_output(input, "uaf_class_scope", "5");
	});

	test("class alias with destroy copies fields correctly", async () => {
		const input = `
class Token {
  var int id

  func #destroy = (ref self) {
    self.id = 0
  }
}

var Token a = Token(1)
var Token b = a
Console.write("\\{a.id}")
Console.write("\\{b.id}")
`;
		await build_and_check_output(input, "uaf_class_alias", "11");
	});
});
