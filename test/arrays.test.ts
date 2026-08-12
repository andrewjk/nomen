import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// BUILD
describe("array build", () => {
	test("array with values in for loop", async () => {
		const input = `
const nums = Array(10, 20, 30)
for n of nums {
  Console.write("\\{n} ")
}
`;
		await build_and_check_output(input, "array_for_loop", "10 20 30 ");
	});

	test("array access by index", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(0)}")
`;
		await build_and_check_output(input, "array_access_index_0", "10");
	});

	test("var string array with literals in function", async () => {
		const input = `
var words = Array("hello", "world")
Console.write("\\{words.at(0)}\\{words.at(1)}")
`;
		await build_and_check_output(input, "var_string_array_literals", "helloworld");
	});

	test("array access middle element", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(1)}")
`;
		await build_and_check_output(input, "array_access_middle", "20");
	});

	test("array access last element", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(2)}")
`;
		await build_and_check_output(input, "array_access_last", "30");
	});

	test("array with explicit type", async () => {
		const input = `
const nums = Array(5, 10, 15)
Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
`;
		await build_and_check_output(input, "array_explicit_type", "5 10 15");
	});

	test("array sum with for loop", async () => {
		const input = `
const nums = Array(1, 2, 3, 4, 5)
var total = 0
for n of nums {
  total = total + n
}
Console.write("\\{total}")
`;
		await build_and_check_output(input, "array_sum_loop", "15");
	});

	test("array with index-based access in loop", async () => {
		const input = `
const nums = Array(100, 200, 300)
var total = 0
for i of 0..3 {
  total = total + nums.at(i)
}
Console.write("\\{total}")
`;
		await build_and_check_output(input, "array_index_loop", "600");
	});

	test("array with single element", async () => {
		const input = `
const nums = Array(42)
Console.write("\\{nums.at(0)}")
`;
		await build_and_check_output(input, "array_single_element", "42");
	});

	test("array with negative values", async () => {
		const input = `
const nums = Array(-1, -5, -10)
Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
`;
		await build_and_check_output(input, "array_negative_values", "-1 -5 -10");
	});

	test("multiple arrays", async () => {
		const input = `
const a = Array(1, 2, 3)
const b = Array(4, 5, 6)
Console.write("\\{a.at(1)} \\{b.at(1)}")
`;
		await build_and_check_output(input, "array_multiple", "2 5");
	});

	test("array access with expression index", async () => {
		const input = `
const nums = Array(10, 20, 30)
const i = 2
Console.write("\\{nums.at(i)}")
`;
		await build_and_check_output(input, "array_expr_index", "30");
	});

	test("empty array with type", async () => {
		const input = `
const Array<int> x
Console.write("ok")
`;
		await build_and_check_output(input, "array_empty_typed", "ok");
	});

	test("nested array access in expression", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(0) + nums.at(2)}")
`;
		await build_and_check_output(input, "array_access_in_expr", "40");
	});

	test("array from Array.with() with dynamic length filled with set() and read with at()", async () => {
		const input = `
var length = 3
var result = Array.with(0, length)
if result.length == 3 {
	result.set(0, 10)
	result.set(1, 20)
	result.set(2, 30)
	Console.write("\\{result.at(0)} \\{result.at(1)} \\{result.at(2)}")
}
`;
		await build_and_check_output(input, "array_with_set_at", "10 20 30");
	});

	test("array from Array.with() reports its dynamic length", async () => {
		const input = `
var length = 7
var result = Array.with(0, length)
Console.write("\\{result.length}")
`;
		await build_and_check_output(input, "array_with_length", "7");
	});

	test("array from Array.with() filled in a loop and iterated", async () => {
		const input = `
var length = 5
var result = Array.with(0, length)
for i of 0 .. result.length {
  result.set(i, i * i)
}
for n of result {
  Console.write("\\{n} ")
}
`;
		await build_and_check_output(input, "array_with_for_loop", "0 1 4 9 16 ");
	});

	test("Array.with() with literal count is heap-allocated (string elements)", async () => {
		const input = `
var result = Array.with("x", 3)
result.set(0, "ab")
result.set(1, "cd")
result.set(2, "ef")
Console.write("\\{result.at(0)}\\{result.at(1)}\\{result.at(2)}")
`;
		await build_and_check_output(input, "array_with_literal_count_strings", "abcdef");
	});

	test("Array.with() with literal count is heap-allocated (int elements)", async () => {
		const input = `
var result = Array.with(0, 4)
result.set(0, 10)
result.set(1, 20)
result.set(2, 30)
result.set(3, 40)
Console.write("\\{result.at(0)} \\{result.at(1)} \\{result.at(2)} \\{result.at(3)}")
`;
		await build_and_check_output(input, "array_with_literal_count_ints", "10 20 30 40");
	});

	test("Array.set on a local persists across a re-read", async () => {
		const input = `
var Array<int> v = Array<int>.with(0, 5)
v.set(2, 11)
v.set(2, 42)
Console.write("\\{v.at(2)}")
`;
		await build_and_check_output(input, "array_set_local_persists", "42");
	});

	// A `ref Array<T>` parameter currently loses writes (the parse-time
	// `Array<T>` → `T[]` rewrite lowers params to an element pointer while locals
	// use the struct pointer — see ROADBLOCKS / FOLLOWUP). `List<T>` is the
	// supported way to mutate a collection across a function boundary.
	test("List<int> ref param persists set (Array<T> ref workaround)", async () => {
		const input = `
func fill = (ref List<int> arr, int idx, int val) {
    if idx >= 0 && idx < arr.length {
        arr.set(idx, val)
    }
}
var List<int> v = List<int>()
v.push(0)
v.push(0)
v.push(0)
v.push(0)
v.push(0)
fill(ref v, 2, 42)
for i of 0 .. v.length {
    Console.write("\\{v.at(i)} ")
}
`;
		await build_and_check_output(input, "list_ref_set_persists", "0 0 42 0 0 ");
	});

	// Regression for the `Array<T>.set` ROADBLOCK: a `ref Array<T>` parameter
	// must persist `.set` writes back to the caller. The parse-time
	// `Array<T>` → `T[]` rewrite previously lowered such a param to a raw
	// element pointer, so `.set` wrote into the caller's stack around the
	// pointer slot instead of the array's data region and `v.at(i)` read the
	// original value. The param now lowers to `struct Array_<T>*` on both
	// backends, matching how a heap-array local is treated.
	test("ref Array<int> param persists set across the call", async () => {
		const input = `
func fill = (ref Array<int> arr, int idx, int val) {
    if idx >= 0 && idx < arr.length {
        arr.set(idx, val)
    }
}
var Array<int> v = Array<int>.with(0, 5)
fill(ref v, 2, 42)
for i of 0 .. v.length {
    Console.write("\\{v.at(i)} ")
}
`;
		await build_and_check_output(input, "array_ref_set_persists", "0 0 42 0 0 ");
	});

	// A non-`ref` `Array<T>` param borrows the caller's struct pointer and can
	// read `.length` / `.at` through it (previously broken — only `for n of`
	// iteration worked because it used the raw data pointer).
	test("non-ref Array<int> param supports .length and .at", async () => {
		const input = `
func sum_all = (Array<int> arr, out int) {
    var total = 0
    for i of 0 .. arr.length {
        total = total + arr.at(i)
    }
    return total
}
var Array<int> v = Array<int>.with(0, 3)
v.set(0, 10)
v.set(1, 20)
v.set(2, 30)
Console.write("\\{sum_all(v)}")
`;
		await build_and_check_output(input, "array_param_length_at", "60");
	});

	test("array in function param", async () => {
		const input = `
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
const n = sum(Array(2, 4, 6))
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_func_param", "12");
	});

	test("function returning out int[] with array literal, consumed via .at()", async () => {
		const input = `
func make_nums = (out int[]) {
  return [1, 2, 3]
}
var nums = make_nums()
if nums.length == 3 {
  Console.write("\\{nums.at(0)}\\{nums.at(1)}\\{nums.at(2)}")
}
`;
		await build_and_check_output(input, "array_func_return_literal_at", "123");
	});

	test("global (root-scope) array .at() inside main", async () => {
		const input = `
import System
const nums = Array(10, 20, 30)
pub func main = () {
  Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
}
`;
		await build_and_check_output(input, "array_global_at_in_func", "10 20 30", true);
	});

	test("function returning out string[] with array literal", async () => {
		const input = `
func make_words = (out string[]) {
  return ["a", "b", "c"]
}
var words = make_words()
if words.length == 3 {
  Console.write("\\{words.at(0)}\\{words.at(1)}\\{words.at(2)}")
}
`;
		await build_and_check_output(input, "array_func_return_string_literal", "abc");
	});

	// Regression: a function returning `Array<T>` (heap-allocated via
	// `Array.with(...)`, not a stack-array literal) must give its
	// `_return_val` temp the correct `struct Array_<T>*` type on the C
	// backend (it previously fell through to `c_type(elem)` e.g. `long`,
	// a pointer/int mismatch that round-tripped on 64-bit but broke
	// 32-bit). The aarch64 backend had a parallel bug: it returned the
	// stack-slot address of the heap-array variable instead of loading the
	// heap pointer. Both are exercised here.
	test("function returning out Array<int> built via Array.with", async () => {
		const input = `
func make_arr = (out Array<int>) {
  var Array<int> dst = Array<int>.with(0, 3)
  dst.set(0, 10)
  dst.set(1, 20)
  dst.set(2, 30)
  return dst
}
var Array<int> a = make_arr()
for n of a {
  Console.write("\\{n} ")
}
`;
		await build_and_check_output(input, "array_func_return_heap_with", "10 20 30 ");
	});

	test("function returning out Array<int> by forwarding another call", async () => {
		const input = `
func make_arr = (out Array<int>) {
  var Array<int> dst = Array<int>.with(0, 2)
  dst.set(0, 7)
  dst.set(1, 9)
  return dst
}
func passthrough = (out Array<int>) {
  return make_arr()
}
var Array<int> a = passthrough()
for n of a {
  Console.write("\\{n} ")
}
`;
		await build_and_check_output(input, "array_func_return_forwarded_call", "7 9 ");
	});

	// The `Array<T>` literal-wrap gap (FOLLOWUP / ROADBLOCKS): passing an array
	// LITERAL directly to an `Array<T>` param whose monomorphized `Array_<T>`
	// struct exists used to pass the stack-array temp where the promoted
	// `struct Array_<T>*` param expected a heap struct pointer — clang rejected
	// it, or (before the length-stamping fix) the param stayed a raw element
	// pointer and `.length`/`.at`/iteration silently read the wrong memory. The
	// hoisted literal temp is now materialised as a heap `Array_<T>` buffer
	// (marked at check time; built by both backends), so the literal round-trips
	// through the struct-typed param.
	test("array literal to Array<int> param when Array_int mono struct exists", async () => {
		const input = `
var Array<int> filler = Array<int>.with(0, 1)
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
const n = sum(Array(2, 4, 6))
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_literal_wrap_int", "12");
	});

	test("string array literal to Array<string> param when Array_string mono struct exists", async () => {
		const input = `
var Array<string> filler = Array<string>.with("", 1)
func join = (Array<string> words, out string) {
  var out = ""
  for w of words {
    out = out + w
  }
  return out
}
const s = join(Array("a", "b", "c"))
Console.write("\\{s}")
`;
		await build_and_check_output(input, "array_literal_wrap_string", "abc");
	});

	// A raw `int[]` param spelling is parse-rewritten identically to
	// `Array<int>`, so with the mono struct present it takes the same heap
	// struct pointer and a literal arg must be wrapped the same way.
	test("array literal to int[] param when Array_int mono struct exists", async () => {
		const input = `
var Array<int> filler = Array<int>.with(0, 1)
func sum = (int[] nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
const n = sum([2, 4, 6])
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_literal_wrap_raw_spelling", "12");
	});

	// When the mono struct is created AFTER the call, the param still goes
	// through the raw-`T[]` path (no length stamping, matching the pre-fix
	// behavior) — the literal must still produce the right answer.
	test("array literal arg when mono struct is created after the call", async () => {
		const input = `
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
const n = sum(Array(2, 4, 6))
var Array<int> filler = Array<int>.with(0, 1)
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_literal_wrap_order_edge", "12");
	});

	// A range literal (`sum(1 .. 3)`) bound to a heap `Array<T>` param is
	// materialised as a heap buffer (its elements expanded), not passed as a
	// stack range temp the promoted param would read past.
	test("range literal to Array<int> param when Array_int mono struct exists", async () => {
		const input = `
var Array<int> filler = Array<int>.with(0, 1)
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
const n = sum(1 .. 3)
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_literal_wrap_range", "3");
	});

	test("non-zero-start range literal to Array<int> param with mono struct", async () => {
		const input = `
var Array<int> filler = Array<int>.with(0, 1)
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
const n = sum(5 .. 8)
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_literal_wrap_range_nonzero", "18");
	});

	// A stack-array VARIABLE (`var Array<int> v = [2, 4, 6]`) bound to a heap
	// `Array<T>` param is copied into a heap `Array_<T>` temp at the call site
	// (the param promotes to `struct Array_<T>*`; the copy is auto-freed and
	// the caller's stack array is left intact for later use).
	test("stack-array variable to Array<int> param when Array_int mono struct exists", async () => {
		const input = `
var Array<int> filler = Array<int>.with(0, 1)
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
var Array<int> v = [2, 4, 6]
const n = sum(v)
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_literal_wrap_stack_var", "12");
	});

	test("stack-array string variable to Array<string> param with mono struct", async () => {
		const input = `
var Array<string> filler = Array<string>.with("", 1)
func join = (Array<string> words, out string) {
  var out = ""
  for w of words {
    out = out + w
  }
  return out
}
var Array<string> v = ["a", "b", "c"]
const s = join(v)
Console.write("\\{s}")
`;
		await build_and_check_output(input, "array_literal_wrap_stack_string_var", "abc");
	});

	test("empty range literal to Array<int> param with mono struct", async () => {
		const input = `
var Array<int> filler = Array<int>.with(0, 1)
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
const n = sum(1 .. 1)
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_literal_wrap_range_empty", "0");
	});

	test("stack-array variable reusable after heap param call", async () => {
		const input = `
var Array<int> filler = Array<int>.with(0, 1)
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
var Array<int> v = [2, 4, 6]
const n = sum(v)
Console.write("\\{n} \\{v.at(1)}")
`;
		await build_and_check_output(input, "array_literal_wrap_stack_var_reuse", "12 4");
	});

	test("const global stack array to Array<int> param with mono struct", async () => {
		const input = `
import System
const g = [2, 4, 6]
pub func main = () {
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
var Array<int> filler = Array<int>.with(0, 1)
const n = sum(g)
Console.write("\\{n}")
}
`;
		await build_and_check_output(input, "array_literal_wrap_stack_global", "12", true);
	});

	test("stack-array variable arg before mono struct exists", async () => {
		const input = `
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
var Array<int> v = [2, 4, 6]
const n = sum(v)
var Array<int> filler = Array<int>.with(0, 1)
Console.write("\\{n}")
`;
		await build_and_check_output(input, "array_literal_wrap_stack_var_order", "12");
	});
});

// ERRORS
describe("array errors", () => {
	test("declaration type mismatch", () => {
		const input = `
const Array<int> x = Array("a", "b", "c")
`;
		const expected = [
			test_error(input, "Type mismatch in array: string (expected int)", 2, 28),
			test_error(input, "Type mismatch in array: string (expected int)", 2, 33),
			test_error(input, "Type mismatch in array: string (expected int)", 2, 38),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("declaration type mixed", () => {
		const input = `
const x = Array(1, "b", 2)
`;
		// Heterogeneous arrays are now treated as tuples (see tuples.test.ts)
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("declaration type not an array", () => {
		const input = `
const Array<int> x = 5
`;
		const expected = [
			test_error(input, "Type mismatch in declaration: int (expected Array<int>)", 2, 22),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("assignment type mismatch", () => {
		const input = `
var Array<int> x
x = Array("a", "b", "c")
`;
		const expected = [
			test_error(input, "Type mismatch in array: string (expected int)", 3, 11),
			test_error(input, "Type mismatch in array: string (expected int)", 3, 16),
			test_error(input, "Type mismatch in array: string (expected int)", 3, 21),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("assignment type mixed", () => {
		const input = `
var Array<int> x
x = Array(1, "b", 2)
`;
		// Heterogeneous arrays are now treated as tuples (see tuples.test.ts),
		// but the explicit Array<int> target still mismatches the tuple value.
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("assignment type not an array", () => {
		const input = `
var Array<int> x
x = 5
`;
		const expected = Array(
			test_error(input, "Type mismatch in assignment: int (expected Array<int>)", 3, 5),
		);
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
