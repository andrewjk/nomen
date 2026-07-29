import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("sret x8 clobber repro", () => {
	test("inline struct-returning method calls struct-returning function", async () => {
		const input = `
struct Big {
  var int a
  var int b
  var int c
}
func make_big = (int n, out Big) {
  return Big(n, n + 1, n + 2)
}
struct Factory {
  var int base = 0
  inline func build = (self, out Big) {
    var Big tmp = make_big(self.base)
    return tmp
  }
}
var Factory f = Factory()
f.base = 10
var Big r = f.build()
Console.write("\\{r.a} \\{r.b} \\{r.c}")
`;
		await build_and_check_output(input, "sret_x8_inline_method", "10 11 12");
	});

	test("standalone struct-returning method calls struct-returning function", async () => {
		const input = `
struct Big {
  var int a
  var int b
  var int c
}
func make_big = (int n, out Big) {
  return Big(n, n + 1, n + 2)
}
struct Factory {
  var int base = 0
  pub func build = (self, out Big) {
    var Big tmp = make_big(self.base)
    return tmp
  }
}
var Factory f = Factory()
f.base = 10
var Big r = f.build()
Console.write("\\{r.a} \\{r.b} \\{r.c}")
`;
		await build_and_check_output(input, "sret_x8_standalone_method", "10 11 12");
	});

	test("inline method returns constructor after struct-returning call", async () => {
		const input = `
struct Big {
  var int a
  var int b
  var int c
}
func make_big = (int n, out Big) {
  return Big(n, n + 1, n + 2)
}
struct Factory {
  var int base = 0
  inline func build = (self, out Big) {
    var Big tmp = make_big(self.base)
    return Big(tmp.a + 1, tmp.b + 1, tmp.c + 1)
  }
}
var Factory f = Factory()
f.base = 20
var Big r = f.build()
Console.write("\\{r.a} \\{r.b} \\{r.c}")
`;
		await build_and_check_output(input, "sret_x8_inline_ctor_return", "21 22 23");
	});

	test("struct-returning function calls struct-returning function", async () => {
		const input = `
struct Big {
  var int a
  var int b
  var int c
}
func make_big = (int n, out Big) {
  return Big(n, n + 1, n + 2)
}
func wrap_big = (int n, out Big) {
  var Big tmp = make_big(n)
  return Big(tmp.a * 2, tmp.b * 2, tmp.c * 2)
}
var Big r = wrap_big(5)
Console.write("\\{r.a} \\{r.b} \\{r.c}")
`;
		await build_and_check_output(input, "sret_x8_func_chain", "10 12 14");
	});

	test("struct return after libc call that clobbers x8", async () => {
		const input = `
struct Big {
  var int a
  var int b
  var int c
}
func make_big = (int n, out Big) {
  Console.write("making ")
  return Big(n, n + 1, n + 2)
}
struct Factory {
  var int base = 0
  pub func build = (self, out Big) {
    var Big tmp = make_big(self.base)
    Console.write("built ")
    return Big(tmp.a + 1, tmp.b + 1, tmp.c + 1)
  }
}
var Factory f = Factory()
f.base = 30
var Big r = f.build()
Console.write("\\{r.a} \\{r.b} \\{r.c}")
`;
		await build_and_check_output(input, "sret_x8_libc_clobber", "making built 31 32 33");
	});
});
