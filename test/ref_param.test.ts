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

	// Compound / read-modify-write writes through a ref param. `n = n + 1`
	// reads `n` (re-deriving the caller's pointer from the slot) and writes the
	// sum back; the write path must not rely on a pointer parked across the RHS
	// build (it gets clobbered), and `+=` must combine the old value with the
	// RHS rather than just storing the RHS.
	test("read-modify-write to ref int param persists", async () => {
		const input = `
func bump = (ref int x) {
  x = x + 1
}

var int num = 41
bump(ref num)
Console.write("\\{num}")
`;
		await build_and_check_output(input, "ref_param_rmw_int", "42");
	});

	test("+= on ref int param persists", async () => {
		const input = `
func incr = (ref int x) {
  x += 5
}

var int num = 10
incr(ref num)
Console.write("\\{num}")
`;
		await build_and_check_output(input, "ref_param_compound_int", "15");
	});

	test("read-modify-write to ref int in a loop persists", async () => {
		const input = `
func count = (ref int acc) {
  var int i = 0
  while i < 5 {
    acc = acc + 1
    i = i + 1
  }
}

var int total = 0
count(ref total)
Console.write("\\{total}")
`;
		await build_and_check_output(input, "ref_param_rmw_loop", "5");
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

	// Small-type writes through a ref param must store with the pointee's width
	// (`strb` for bool/uint8), not an 8-byte `str` that clobbers adjacent
	// memory. Writing `true` (1) with `str x0` would splat zeros/ones across
	// neighbouring stack slots.
	test("ref bool set true persists without corrupting neighbours", async () => {
		const input = `
func turn_on = (ref bool flag) {
  flag = true
}

var bool on = false
turn_on(ref on)
var int result = 0
if on {
  result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "ref_bool_write_true", "1");
	});

	test("ref uint8 read-modify-write persists", async () => {
		const input = `
func grow = (ref uint8 n) {
  n = n + 5
}

var uint8 v = 3
grow(ref v)
Console.write("\\{v}")
`;
		await build_and_check_output(input, "ref_uint8_rmw", "8");
	});

	test("+= on ref uint8 param persists", async () => {
		const input = `
func add = (ref uint8 n) {
  n += 5
}

var uint8 v = 3
add(ref v)
Console.write("\\{v}")
`;
		await build_and_check_output(input, "ref_uint8_compound", "8");
	});

	test("ref int16 write persists with correct width", async () => {
		const input = `
func set = (ref int16 n) {
  n = 32000
}

func fetch = (ref int16 n, out int) {
  return n
}

var int16 v = 0
set(ref v)
Console.write("\\{fetch(ref v)}")
`;
		await build_and_check_output(input, "ref_int16_write", "32000");
	});
});

describe("ref arg lvalue requirement", () => {
	// A `ref` argument must be a mutable lvalue — caller storage the callee
	// can borrow. Literals and computed expressions have no storage: both
	// backends used to materialize an address for them anyway (aarch64
	// emitted `adr x0, 5` — caught by the asm validator; C emitted
	// `&(a * 2L)` / `&5L`, an rvalue address clang rejects).
	test("literal ref arg is a compile error", () => {
		const parsed = parse_with_imports(`
func incr = (ref int v) {
	v = v + 1
}
incr(ref 5)
`);
		expect(
			parsed.errors.some((e) =>
				e.message.includes("Cannot pass a literal value to ref parameter 'v'"),
			),
		).toBe(true);
	});

	test("computed ref arg is a compile error", () => {
		const parsed = parse_with_imports(`
func incr = (ref int v) {
	v = v + 1
}
var a = 5
var b = 3
incr(ref a * b)
`);
		expect(
			parsed.errors.some((e) =>
				e.message.includes("Cannot pass a computed value to ref parameter 'v'"),
			),
		).toBe(true);
	});

	test("field-access ref arg still works", async () => {
		const input = `
struct P {
	var int f
}

func incr = (ref int v) {
	v = v + 1
}

var P p = P(7)
incr(ref p.f)
Console.write("\\{p.f}")
`;
		await build_and_check_output(input, "ref_field_lvalue", "8");
	});
});
