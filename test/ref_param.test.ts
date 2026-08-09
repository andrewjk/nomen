import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Assert the checker (run as part of `parse`) accepts the program.
function expect_parse_ok(input: string) {
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
}

// BUILD
describe("ref param dereference", () => {
	test("reading ref int param returns correct value", async () => {
		const input = `
func read_ref = (ref int x, out int) {
  return x
}

var int num = 42
Console.write("\\{read_ref(ref num)}")
`;
		await build_and_check_output(input, "ref_param_read", "42");
	});

	test("ref int param used in comparison", async () => {
		const input = `
func count_up = (ref int limit, out int) {
  var int count = 0
  var int i = 0
  while i < limit {
    count = count + 1
    i = i + 1
  }
  return count
}

var int n = 5
Console.write("\\{count_up(ref n)}")
`;
		await build_and_check_output(input, "ref_param_comparison", "5");
	});

	test("ref int param used in arithmetic", async () => {
		const input = `
func add_one = (ref int x, out int) {
  return x + 1
}

var int num = 10
Console.write("\\{add_one(ref num)}")
`;
		await build_and_check_output(input, "ref_param_arithmetic", "11");
	});

	test("writing to ref int param modifies caller variable", async () => {
		const input = `
func set_val = (ref int x) {
  x = 99
}

var int num = 1
set_val(ref num)
Console.write("\\{num}")
`;
		await build_and_check_output(input, "ref_param_write", "99");
	});

	test("multiple ref params read correctly", async () => {
		const input = `
func swap_check = (ref int a, ref int b, out int) {
  var int tmp = a
  a = b
  return tmp + b
}

var int x = 3
var int y = 7
Console.write("\\{swap_check(ref x, ref y)}")
`;
		await build_and_check_output(input, "ref_param_multiple", "10");
	});
});

describe("ref bool as condition", () => {
	test("checker accepts ref bool directly in an if condition", () => {
		const input = `
func put = (ref bool flag, out int) {
  if flag {
    return 1
  }
  return 0
}
`;
		expect_parse_ok(input);
	});

	test("ref bool directly in an if condition (C runtime)", async () => {
		const input = `
func put = (ref bool flag, out int) {
  if flag {
    return 1
  }
  return 0
}

var bool on = true
Console.write("\\{put(ref on)}")
`;
		await build_and_check_output(input, "ref_bool_if", "1");
	});

	test("checker accepts ref bool directly in a while condition", () => {
		const input = `
func countdown = (ref bool keep_going, out int) {
  var int n = 0
  while keep_going {
    n = n + 1
    if n >= 3 {
      keep_going = false
    }
  }
  return n
}
`;
		expect_parse_ok(input);
	});

	test("ref bool in a while condition (C runtime)", async () => {
		const input = `
func countdown = (ref bool keep_going, out int) {
  var int n = 0
  while keep_going {
    n = n + 1
    if n >= 3 {
      keep_going = false
    }
  }
  return n
}

var bool go = true
Console.write("\\{countdown(ref go)}")
`;
		await build_and_check_output(input, "ref_bool_while", "3");
	});

	test("ref bool flipped by callee is observed by caller (C runtime)", async () => {
		const input = `
func clear = (ref bool flag) {
  flag = false
}

var bool on = true
clear(ref on)
var int result = 0
if on {
  result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "ref_bool_flip", "0");
	});

	test("checker accepts ref bool in a switch case condition", () => {
		const input = `
func classify = (ref bool flag, out int) {
  var int result = 0
  switch {
    case flag {
      result = 1
    }
    else {
      result = 0
    }
  }
  return result
}
`;
		expect_parse_ok(input);
	});

	test("checker rejects a non-bool ref type as a condition", () => {
		const input = `
func bad = (ref int n, out int) {
  if n {
    return 1
  }
  return 0
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("must be a bool"))).toBe(true);
	});
});

describe("ref small-type params (bool/uint8 deref width)", () => {
	test("ref uint8 zero-extends on read", async () => {
		const input = `
func get = (ref uint8 n, out int) {
  return n
}

var uint8 v = 250
Console.write("\\{get(ref v)}")
`;
		await build_and_check_output(input, "ref_uint8_read", "250");
	});

	test("ref int8 sign-extends on read", async () => {
		const input = `
func get_neg = (ref int8 n, out int) {
  return n
}

var int8 v = -5
Console.write("\\{get_neg(ref v)}")
`;
		await build_and_check_output(input, "ref_int8_signext", "-5");
	});
});
