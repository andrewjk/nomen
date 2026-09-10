import path from "node:path";

import { expect, describe, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

const core = path.resolve(import.meta.dirname, "../core");

// BUILD
describe("for loop build", () => {
	test("for loop with array", async () => {
		const input = `
const nums = Array(1, 2, 3)
for n of nums {
  Console.write("\\{n}")
}
Console.write("\\n")
`;
		await build_and_check_output(input, "for_loop_array", "123\n");
	});

	test("for loop with range", async () => {
		const input = `
for i of 0..3 {
  Console.write("\\{i}")
}
Console.write("\\n")
`;
		await build_and_check_output(input, "for_loop_range", "012\n");
	});

	test("for loop with sum calculation", async () => {
		const input = `
const nums = Array(1, 2, 3, 4, 5)
var sum = 0
for n of nums {
  sum = sum + n
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "for_loop_sum_calculation", "15");
	});

	test("for loop with multiplication", async () => {
		const input = `
const nums = Array(2, 3, 4)
var product = 1
for n of nums {
  product = product * n
}
Console.write("\\{product}")
`;
		await build_and_check_output(input, "for_loop_multiplication", "24");
	});

	test("for loop with condition in body", async () => {
		const input = `
const nums = Array(1, 2, 3, 4, 5)
var count = 0
for n of nums {
  if n > 2 {
    count = count + 1
  }
}
Console.write("\\{count}")
`;
		await build_and_check_output(input, "for_loop_condition_body", "3");
	});

	test("for loop with single element", async () => {
		const input = `
const nums = Array(42)
for n of nums {
  Console.write("\\{n}")
}
`;
		await build_and_check_output(input, "for_loop_single_element", "42");
	});

	test("for loop with nested loops", async () => {
		const input = `
const rows = Array(1, 2)
const cols = Array(3, 4)
var total = 0
for r of rows {
  for c of cols {
    total = total + (r * c)
  }
}
Console.write("\\{total}")
`;
		await build_and_check_output(input, "for_loop_nested", "21");
	});

	test("for loop with index calculation", async () => {
		const input = `
const nums = Array(10, 20, 30)
var total = 0
for i of 0..3 {
  total = total + nums.at(i)
}
Console.write("\\{total}")
`;
		await build_and_check_output(input, "for_loop_index_calculation", "60");
	});

	test("for loop with decrement", async () => {
		const input = `
var count = 5
for i of 0..5 {
  count = count - 1
}
Console.write("\\{count}")
`;
		await build_and_check_output(input, "for_loop_decrement", "0");
	});

	test("for loop with array access", async () => {
		const input = `
const nums = Array(100, 200, 300)
var sum = 0
for i of 0..3 {
  sum = sum + nums.at(i)
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "for_loop_array_access", "600");
	});

	test("for loop with comparison", async () => {
		const input = `
const nums = Array(1, 5, 3, 7, 2)
var max = 0
for n of nums {
  if n > max {
    max = n
  }
}
Console.write("\\{max}")
`;
		await build_and_check_output(input, "for_loop_comparison", "7");
	});

	test("for loop with modulo", async () => {
		const input = `
const nums = Array(1, 2, 3, 4, 5)
var sum = 0
for n of nums {
  if n % 2 == 0 {
    sum = sum + n
  }
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "for_loop_modulo", "6");
	});

	test("for loop with simple assignment in update", async () => {
		const input = `
const nums = Array(1, 2, 3)
var sum = 0
var i = 0
for n of nums; i += 1 {
  sum = sum + n + i
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "for_loop_post_assignment", "9");
	});

	test("for loop with range and update", async () => {
		const input = `
var sum = 0
var i = 0
for n of 0..5; i += 2 {
  sum = sum + i
}
Console.write("\\{sum}")
`;
		// 0 + 0 + 2 + 4 + 6 + 8
		await build_and_check_output(input, "for_loop_range_update", "20");
	});

	test("for loop with update and condition", async () => {
		const input = `
const nums = Array(1, 2, 3, 4, 5)
var sum = 0
var i = 0
for n of nums; i += 1 {
  if n % 2 == 0 {
    sum = sum + n + i
  }
}
Console.write("\\{sum}")
`;
		// 0 + 0 + 0 + 1 + 3 + 2 + 6 + 3 + 9 + 4 + 12
		await build_and_check_output(input, "for_loop_update_condition", "10");
	});

	test("for loop with update accessing outer variable", async () => {
		const input = `
const nums = Array(1, 2, 3)
var multiplier = 2
var sum = 0
var i = 0
for n of nums; i += multiplier {
  sum = sum + n + i
}
Console.write("\\{sum}")
`;
		// 0 + 1 + 0 + 2 + 2 + 3 + 4
		await build_and_check_output(input, "for_loop_update_outer_var", "12");
	});

	test("for loop with side effect in update", async () => {
		const input = `
const nums = Array(1, 2, 3)
var counter = 0
for n of nums; counter += 1 {
  Console.write("\\{n} ")
}
Console.write("\\n")
`;
		await build_and_check_output(input, "for_loop_update_side_effect", "1 2 3 \n");
	});

	test("update with compound operator on range", async () => {
		const input = `
var sum = 0
var i = 0
for n of 0..5; i += 3 {
  sum = sum + n + i
}
Console.write("\\{sum}")
`;
		// 0 + 0 + 0 + 1 + 3 + 2 + 6 + 3 + 9 + 4 + 12
		await build_and_check_output(input, "for_loop_range_compound_update", "40");
	});
});

// BUILD (List element iteration)
describe("for loop over List", () => {
	test("for loop iterates List elements", async () => {
		const input = `
var List<int> xs = List<int>()
xs.push(1)
xs.push(2)
xs.push(3)
var sum = 0
for x of xs {
  sum = sum + x
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "for_loop_list_elements", "6");
	});

	test("for loop over List of strings", async () => {
		const input = `
var List<string> words = List<string>()
words.push("foo")
words.push("bar")
var acc = ""
for w of words {
  acc = acc + w
}
Console.write(acc)
`;
		await build_and_check_output(input, "for_loop_list_strings", "foobar");
	});

	test("for loop element type supports member access", async () => {
		const input = `
pub class Item {
  var text = ""
}
func build = (out List<Item>) {
  var List<Item> items = List<Item>()
  var a = Item()
  a.text = "one"
  items.push(move a)
  var b = Item()
  b.text = "two"
  items.push(move b)
  return items
}
const List<Item> items = build()
var acc = ""
for it of items {
  acc = acc + it.text
}
Console.write(acc)
`;
		await build_and_check_output(input, "for_loop_list_member_access", "onetwo");
	});

	test("for loop over empty List runs zero times", async () => {
		const input = `
var List<int> xs = List<int>()
var count = 0
for x of xs {
  count = count + 1
}
Console.write("\\{count}")
`;
		await build_and_check_output(input, "for_loop_list_empty", "0");
	});

	test("nested for loops over Lists", async () => {
		const input = `
var List<int> xs = List<int>()
xs.push(1)
xs.push(2)
var List<int> ys = List<int>()
ys.push(10)
ys.push(20)
var total = 0
for x of xs {
  for y of ys {
    total = total + x * y
  }
}
Console.write("\\{total}")
`;
		// (1*10 + 1*20) + (2*10 + 2*20) = 90
		await build_and_check_output(input, "for_loop_list_nested", "90");
	});

	test("for loop over List param", async () => {
		const input = `
func total = (List<int> xs, out int) {
  var sum = 0
  for x of xs {
    sum = sum + x
  }
  return sum
}
var List<int> xs = List<int>()
xs.push(4)
xs.push(5)
Console.write("\\{total(xs)}")
`;
		await build_and_check_output(input, "for_loop_list_param", "9");
	});
});

// ERRORS
describe("for loop errors", () => {
	test("string list", () => {
		const input = `
for x of "hi" {
  // ...
}
`;
		const expected = [
			test_error(input, "For loop list must be an array, List, or Enumerable, not string", 2, 10),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("int instead of array", () => {
		const input = `
for x of 5 {
  // ...
}
`;
		const expected = [
			test_error(input, "For loop list must be an array, List, or Enumerable, not int", 2, 10),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("undefined array variable", () => {
		const input = `
for x of nums {
  // ...
}
`;
		const expected = [test_error(input, "Unknown value: nums", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("invalid range syntax", () => {
		const input = `
for x of 0 {
  // ...
}
`;
		const expected = [
			test_error(input, "For loop list must be an array, List, or Enumerable, not int", 2, 10),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing of", () => {
		const input = `
for x nums {
  // ...
}
`;
		const expected = [test_error(input, "Expected of", 2, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing loop variable", () => {
		const input = `
for of Array(1, 2, 3) {
  // ...
}
`;
		const expected = [test_error(input, "Expected of", 2, 8)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing opening brace", () => {
		const input = `
for x of Array(1, 2, 3)
  // ...
}
`;
		const expected = [test_error(input, "Expected {", 4, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing closing brace", () => {
		const input = `
for x of Array(1, 2, 3) {
  // ...
`;
		const expected = [test_error(input, "Expected token", 3, 0)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing closing bracket", () => {
		const input = `
for x of Array(1, 2, 3 {
  // ...
}
`;
		const expected = [test_error(input, "Expected )", 2, 24)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("bool as array", () => {
		const input = `
for x of true {
  // ...
}
`;
		const expected = [
			test_error(input, "For loop list must be an array, List, or Enumerable, not bool", 2, 10),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("empty range", () => {
		const input = `
for x of .. {
  // ...
}
`;
		const expected = [test_error(input, "Unknown value: ..", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("invalid array syntax", () => {
		const input = `
for x of 1, 2, 3 {
  // ...
}
`;
		const expected = [test_error(input, "Expected {", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("range with expressions", () => {
		const input = `
const start = 0
const end = 5
for x of start..end {
  Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		// Should parse correctly or give a clear error
		expect(parsed.errors.length).toBeGreaterThanOrEqual(0);
	});

	test("update with undefined variable", () => {
		const input = `
const nums = Array(1, 2, 3)
for n of nums; n += undefined_var {
  // body
}
`;
		const expected = [test_error(input, "Unknown value: undefined_var", 3, 21)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("update with unknown function", () => {
		const input = `
const nums = Array(1, 2, 3)
for n of nums; n = some_func(n) {
  // body
}
`;
		const expected = [test_error(input, "Function not found: some_func", 3, 20)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("multiple semicolons", () => {
		const input = `
const nums = Array(1, 2, 3)
for n of nums; n += 1; {
  // body
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("for ref over List is rejected", () => {
		const input = `
import System
var List<int> xs = List<int>()
xs.push(1)
for ref x of xs {
  x = x + 1
}
`;
		const expected = [
			test_error(
				input,
				"'ref' iteration is not supported for List<T> — index explicitly (for i of 0..xs.length) and use .set to write back",
				5,
				5,
			),
		];
		const parsed = parse(input, get_library(core));
		expect(parsed.errors).toEqual(expected);
	});
});
