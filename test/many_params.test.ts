import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression tests for AAPCS64 stack-argument passing on the aarch64 backend.
// The first 8 argument slots arrive in x0..x7; further slots arrive on the
// caller's stack. Prior to this fix the aarch64 backend's prologue indexed
// past the end of its 8-element param_regs array and emitted malformed
// `str undefined, [...]` stores (and the matching call site dropped the
// overflow arg), so any function with more than 8 register-argument slots
// failed to assemble. Both backends (`c` and `aarch64`) are exercised.

describe("many params build", () => {
	test("function with 9 params (one overflow)", async () => {
		const input = `
func nine = (int a, int b, int c, int d, int e, int f, int g, int h, int i, out int) {
  return a + b + c + d + e + f + g + h + i
}
Console.write("\\{nine(1, 2, 3, 4, 5, 6, 7, 8, 9)}")
`;
		await build_and_check_output(input, "many_params_nine", "45");
	});

	test("function with 12 params (four overflow)", async () => {
		const input = `
func twelve = (
  int a, int b, int c, int d, int e, int f, int g, int h,
  int i, int j, int k, int l, out int
) {
  return a + b + c + d + e + f + g + h + i + j + k + l
}
Console.write("\\{twelve(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)}")
`;
		await build_and_check_output(input, "many_params_twelve", "12");
	});

	test("overflow arg is the discriminant (different per slot)", async () => {
		const input = `
func ten = (
  int a, int b, int c, int d, int e, int f, int g, int h,
  int ninth, int tenth, out int
) {
  return ninth * 100 + tenth
}
Console.write("\\{ten(0, 0, 0, 0, 0, 0, 0, 0, 4, 2)}")
`;
		await build_and_check_output(input, "many_params_discriminant", "402");
	});

	test("overflow args interleave with reads in the body", async () => {
		const input = `
func eleven = (
  int a, int b, int c, int d, int e, int f, int g, int h,
  int i, int j, int k, out int
) {
  var int sum = a + b + c + d + e + f + g + h
  sum = sum + i + j + k
  return sum
}
Console.write("\\{eleven(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)}")
`;
		await build_and_check_output(input, "many_params_eleven_interleave", "66");
	});

	test("struct #init with more than 7 fields (params overflow past x0)", async () => {
		const input = `
struct Wide {
  var int a
  var int b
  var int c
  var int d
  var int e
  var int f
  var int g
  var int h
  var int i
  var int j
}

func sum_wide = (Wide w, out int) {
  return w.a + w.b + w.c + w.d + w.e + w.f + w.g + w.h + w.i + w.j
}

var Wide x = Wide(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
Console.write("\\{sum_wide(x)}")
`;
		await build_and_check_output(input, "many_params_struct_init", "55");
	});

	test("struct method with overflow params", async () => {
		const input = `
struct S {
  var int base

  func nine = (self, int a, int b, int c, int d, int e, int f, int g, int h, int i, out int) {
    return self.base + a + b + c + d + e + f + g + h + i
  }
}

var S s = S(100)
Console.write("\\{s.nine(1, 2, 3, 4, 5, 6, 7, 8, 9)}")
`;
		await build_and_check_output(input, "many_params_struct_method", "145");
	});

	test("nested call where inner call overflows", async () => {
		const input = `
func ten = (
  int a, int b, int c, int d, int e, int f, int g, int h, int i, int j, out int
) {
  return a + b + c + d + e + f + g + h + i + j
}
func caller = (out int) {
  return ten(10, 20, 30, 40, 50, 60, 70, 80, 90, 100)
}
Console.write("\\{caller()}")
`;
		await build_and_check_output(input, "many_params_nested", "550");
	});

	// Variadic-tuple calls pack the trailing `...T` args into a hidden
	// (count, pointer) slot pair. With enough fixed params that pair (and the
	// fixed params themselves) spill past the 8 register slots into the
	// caller's outgoing stack area — the combination that was the last
	// remaining AAPCS64 gap.
	test("variadic call where the pointer slot overflows", async () => {
		const input = `
func varsum7 = (int a, int b, int c, int d, int e, int f, int g, ...int nums, out int) {
  var int total = a + b + c + d + e + f + g
  var int i = 0
  while i < nums.length {
    total = total + nums.at(i)
    i = i + 1
  }
  return total
}
Console.write("\\{varsum7(1, 2, 3, 4, 5, 6, 7, 100, 200)}")
`;
		await build_and_check_output(input, "many_params_variadic_ptr_overflow", "328");
	});

	test("variadic call where both count and pointer overflow", async () => {
		const input = `
func varsum8 = (
  int a, int b, int c, int d, int e, int f, int g, int h, ...int nums, out int
) {
  var int total = a + b + c + d + e + f + g + h
  var int i = 0
  while i < nums.length {
    total = total + nums.at(i)
    i = i + 1
  }
  return total
}
Console.write("\\{varsum8(1, 2, 3, 4, 5, 6, 7, 8, 1000, 2000, 3000)}")
`;
		await build_and_check_output(input, "many_params_variadic_count_ptr_overflow", "6036");
	});

	test("variadic constructor #init with overflow (count/ptr past x7)", async () => {
		const input = `
struct VSum {
  var int fixed_total
  var int var_count
  var int var_first

  func #init = (self, int a, int b, int c, int d, int e, int f, int g, ...int rest) {
    self.fixed_total = a + b + c + d + e + f + g
    self.var_count = rest.length
    if rest.length > 0 {
      self.var_first = rest.at(0)
    }
  }
}

var VSum v = VSum(1, 2, 3, 4, 5, 6, 7, 100, 200, 300)
Console.write("\\{v.fixed_total}|\\{v.var_count}|\\{v.var_first}")
`;
		await build_and_check_output(input, "many_params_variadic_ctor_overflow", "28|3|100");
	});

	// The FOLLOWUP.md repro: 11 `ref int` params — 3 overflow slots. The
	// callee prologue must spill each overflow ref slot (the &caller-storage
	// pointer) from the caller's outgoing stack area into its local slot, and
	// reads AND writes through every param must hit the caller's variable —
	// including when a read feeds a method call (interpolation's to_string),
	// which used to format the caller variable's ADDRESS instead of its
	// value.
	test("11 ref int params: overflow spill plus reads and writes", async () => {
		const input = `
import System

func wide = (ref int a, ref int b, ref int c, ref int d, ref int e, ref int f, ref int g, ref int h, ref int i, ref int j, ref int k, out string) {
  a = a + 1
  k = k + a
  return "\\{a} \\{b} \\{c} \\{d} \\{e} \\{f} \\{g} \\{h} \\{i} \\{j} \\{k}"
}

pub func main = () {
  var a = 100
  var b = 100
  var c = 100
  var d = 100
  var e = 100
  var f = 100
  var g = 100
  var h = 100
  var i = 100
  var j = 100
  var k = 100
  Console.write_line(wide(ref a, ref b, ref c, ref d, ref e, ref f, ref g, ref h, ref i, ref j, ref k))
}
`;
		// a = 101, k = 100 + 101 = 201; the rest stay 100. Both written
		// params (a: register slot 0, k: overflow slot 10) round-trip.
		await build_and_check_output(
			input,
			"many_params_eleven_refs",
			"101 100 100 100 100 100 100 100 100 100 201\n",
			true,
		);
	});

	// Fat `string` params consume TWO AAPCS64 slots each (ptr, len pair).
	// With 4 ints + 5 strings (14 slots), the trailing pairs land past x7 —
	// the prologue must spill BOTH halves of each overflow pair, including a
	// pair that straddles the register/overflow boundary.
	test("fat string pairs past slot 8", async () => {
		const input = `
import System

func join5 = (int a, string s1, int b, string s2, int c, string s3, int d, string s4, string s5, out string) {
  return "\\{a} \\{s1} \\{b} \\{s2} \\{c} \\{s3} \\{d} \\{s4} \\{s5}"
}

pub func main = () {
  Console.write_line(join5(1, "aa", 2, "bb", 3, "cc", 4, "dd", "ee"))
}
`;
		await build_and_check_output(
			input,
			"many_params_fat_strings_overflow",
			"1 aa 2 bb 3 cc 4 dd ee\n",
			true,
		);
	});
});
