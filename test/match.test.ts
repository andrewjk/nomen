import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// Match is exhaustive: enums must cover all cases, other types require else

// BUILD
describe("match build", () => {
	test("match single case", async () => {
		const input = `
var x = 5
match x {
	case 5 {
		Console.write("five")
	}
	else {
		Console.write("other")
	}
}
`;
		await build_and_check_output(input, "match_single", "five");
	});

	test("match single case not matched", async () => {
		const input = `
var x = 3
var int result = 0
match x {
	case 5 {
		result = 1
	}
	else {
		result = 0
	}
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "match_not_matched", "0");
	});

	test("match multiple cases first matches", async () => {
		const input = `
var x = 5
match x {
	case 5 {
		Console.write("five")
	}
	case 10 {
		Console.write("ten")
	}
	case 15 {
		Console.write("fifteen")
	}
	else {
		Console.write("other")
	}
}
`;
		await build_and_check_output(input, "match_first", "five");
	});

	test("match multiple cases second matches", async () => {
		const input = `
var x = 10
match x {
	case 5 {
		Console.write("five")
	}
	case 10 {
		Console.write("ten")
	}
	case 15 {
		Console.write("fifteen")
	}
	else {
		Console.write("other")
	}
}
`;
		await build_and_check_output(input, "match_second", "ten");
	});

	test("match multiple cases third matches", async () => {
		const input = `
var x = 15
match x {
	case 5 {
		Console.write("five")
	}
	case 10 {
		Console.write("ten")
	}
	case 15 {
		Console.write("fifteen")
	}
	else {
		Console.write("other")
	}
}
`;
		await build_and_check_output(input, "match_third", "fifteen");
	});

	test("match with else branch", async () => {
		const input = `
var x = 99
match x {
	case 5 {
		Console.write("five")
	}
	else {
		Console.write("other")
	}
}
`;
		await build_and_check_output(input, "match_else", "other");
	});

	test("match expression", async () => {
		const input = `
var x = 2
const y = match x {
	case 1 -> "one"
	case 2 -> "two"
	case 3 -> "three"
	else -> "other"
}
Console.write(y)
`;
		await build_and_check_output(input, "match_expression", "two");
	});

	test("match expression else branch", async () => {
		const input = `
var x = 99
const y = match x {
	case 1 -> "one"
	case 2 -> "two"
	else -> "other"
}
Console.write(y)
`;
		await build_and_check_output(input, "match_expression_else", "other");
	});

	test("match with variable assignment", async () => {
		const input = `
var int x = 10
var int result = 0
match x {
	case 5 {
		result = 1
	}
	case 10 {
		result = 2
	}
	case 15 {
		result = 3
	}
	else {
		result = 0
	}
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "match_var_assign", "2");
	});

	test("match nested", async () => {
		const input = `
var int x = 3
var int y = 7
var int result = 0
match x {
	case 3 {
		match y {
			case 7 {
				result = 1
			}
			else {
				result = 2
			}
		}
	}
	else {
		result = 0
	}
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "match_nested", "1");
	});

	test("match inside for loop", async () => {
		const input = `
var int result = 0
for i of 0..5 {
	match i {
		case 2 {
			result = result + 10
		}
		case 3 {
			result = result + 20
		}
		else {
			result = result + 1
		}
	}
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "match_in_for", "33");
	});

	test("match expression with int result", async () => {
		const input = `
const x = 3
const y = match x {
	case 1 -> 10
	case 2 -> 20
	case 3 -> 30
	else -> 0
}
Console.write("\\{y}")
`;
		await build_and_check_output(input, "match_int_expression", "30");
	});

	test("match with 0 and 1 values", async () => {
		const input = `
var int x = 1
var int result = 0
match x {
	case 1 {
		result = 1
	}
	case 0 {
		result = 2
	}
	else {
		result = 3
	}
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "match_01", "1");
	});

	test("match with negative values", async () => {
		const input = `
var int x = -1
var int result = 0
match x {
	case -1 {
		result = 1
	}
	case 0 {
		result = 2
	}
	else {
		result = 3
	}
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "match_negative", "1");
	});

	test("match with expression case values", async () => {
		const input = `
var int x = 5
var int result = 0
match x {
	case 2 + 3 {
		result = 1
	}
	else {
		result = 2
	}
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "match_expr_case", "1");
	});

	test("match on enum", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

var direction = Direction.south
match direction {
	case .north {
		Console.write("north")
	}
	case .south {
		Console.write("south")
	}
	else {
		Console.write("other")
	}
}
`;
		await build_and_check_output(input, "match_enum", "south");
	});

	test("match on enum as expression", async () => {
		const input = `
enum Direction {
  case north
  case south
}

var direction = Direction.north
const label = match direction {
	case .north -> "N"
	case .south -> "S"
	else -> "?"
}
Console.write(label)
`;
		await build_and_check_output(input, "match_enum_expr", "N");
	});

	test("match on bool", async () => {
		const input = `
var bool flag = true
match flag {
	case true {
		Console.write("yes")
	}
	case false {
		Console.write("no")
	}
}
`;
		await build_and_check_output(input, "match_bool", "yes");
	});

	test("match on enum C output", () => {
		const input = `
enum Direction {
  case north
  case south
}

func main = () {
  var direction = Direction.north
  match direction {
    case .north {
      Console.write("north")
    }
    case .south {
      Console.write("south")
    }
  }
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "c" });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("switch");
		expect(result.code).toContain("Direction_north");
		expect(result.code).toContain("Direction_south");
	});

	test("match associated-data extraction (enum with data)", async () => {
		const input = `
enum Len {
  case auto
  case fixed(int pixels)
}

var Len w = Len.fixed(50)
var int n = match w {
  case .fixed(x) -> x
  else -> 0
}
Console.write("\\{n}")
`;
		await build_and_check_output(input, "match_associated_data_extract", "50");
	});

	test("match associated-data extraction, multiple cases", async () => {
		const input = `
enum Shape {
  case circle(int radius)
  case rect(int width, int height)
}

var Shape s = Shape.rect(10, 20)
var int area = match s {
  case .circle(r) -> 3 * r * r
  case .rect(w, h) -> w * h
}
Console.write("\\{area}")
`;
		await build_and_check_output(input, "match_associated_data_multi", "200");
	});

	// Regression: a match-as-expression whose branches return string
	// interpolations used to emit the hoisted interpolation temp AFTER the
	// assignment target (`m = char* _param_0 = ...`) — a declaration
	// mid-expression, which clang rejects with `expected expression`. The
	// temps must hoist before the branch's assignment (both backends).
	test("match-as-expression with interpolated string branches", async () => {
		const input = `
enum Result {
  case ok(int value)
  case error(string message)
}

var Result r = .ok(5)
const m = match r {
	case .ok(n) -> "ok \\{n}"
	case .error(e) -> "err \\{e}"
}
Console.write(m)
Console.write("\\n")

var Result r2 = .error("bad")
const m2 = match r2 {
	case .ok(n) -> "ok \\{n}"
	case .error(e) -> "err \\{e}"
}
Console.write(m2)
Console.write("\\n")
`;
		await build_and_check_output(input, "match_expr_interp", "ok 5\nerr bad\n");
	});

	test("match-as-expression with multiple interpolations per branch", async () => {
		const input = `
enum Result {
  case ok(int value)
  case error(string message)
}

var Result r = .ok(5)
const m = match r {
	case .ok(n) -> "ok \\{n} \\{n + 1}"
	case .error(e) -> "err \\{e}"
}
Console.write(m)
Console.write("\\n")
`;
		await build_and_check_output(input, "match_expr_multi_interp", "ok 5 6\n");
	});

	test("match-as-expression with interpolated string on a simple enum", async () => {
		const input = `
enum Direction {
  case north
  case south
}

var Direction d = .north
const m = match d {
	case .north -> "N \\{1}"
	case .south -> "S \\{2}"
}
Console.write(m)
Console.write("\\n")
`;
		await build_and_check_output(input, "match_expr_simple_interp", "N 1\n");
	});

	// `return match` with interpolation branches: the chosen branch's value
	// must survive the branch's auto-free of the hoisted interpolation temp
	// (which clobbers x0) and reach the caller without leaking the owned
	// original (per-branch join normalization, no join-point strdup).
	test("return match with interpolated string branches", async () => {
		const input = `
enum Result {
  case ok(int value)
  case error(string message)
}

func describe = (Result r, out string) {
    return match r {
        case .ok(n) -> "ok \\{n}"
        case .error(e) -> "err \\{e}"
    }
}

Console.write(describe(.ok(7)))
Console.write("\\n")
Console.write(describe(.error("nope")))
Console.write("\\n")
`;
		await build_and_check_output(input, "match_return_interp", "ok 7\nerr nope\n");
	});

	// Mixed literal + interpolation branches: the literal branch dominates the
	// match type's is_static merge, so auto_free used to skip the variable and
	// the interpolation branch's heap result leaked (C: audit LEAK; aarch64:
	// the literal branch's rodata pointer was freed at exit → SIGABRT). The
	// join is now normalized per-branch: non-owned branch values are strdup'd
	// and the variable owns its result uniformly.
	test("match-as-expression with mixed literal and interpolated string branches", async () => {
		const input = `
enum Result {
  case ok(int value)
  case error(string message)
}

var Result r = .ok(5)
const m = match r {
	case .ok(n) -> "ok \\{n}"
	case .error -> "err"
}
Console.write(m)
Console.write("\\n")

var Result r2 = .error("bad")
const m2 = match r2 {
	case .ok(n) -> "ok \\{n}"
	case .error -> "err"
}
Console.write(m2)
Console.write("\\n")
`;
		await build_and_check_output(input, "match_expr_mixed_interp_literal", "ok 5\nerr\n");
	});

	// Same mixed join with the literal branch FIRST (the is_static merge is
	// last-branch-wins, so this order infers a non-static type instead — both
	// orders must produce an owned, freed-once result).
	test("match-as-expression with mixed literal-first string branches", async () => {
		const input = `
enum Result {
  case ok(int value)
  case error(string message)
}

var Result r = .ok(5)
const m = match r {
	case .error -> "err"
	case .ok(n) -> "ok \\{n}"
}
Console.write(m)
Console.write("\\n")

var Result r2 = .error("bad")
const m2 = match r2 {
	case .error -> "err"
	case .ok(n) -> "ok \\{n}"
}
Console.write(m2)
Console.write("\\n")
`;
		await build_and_check_output(input, "match_expr_mixed_literal_first", "ok 5\nerr\n");
	});

	// A mixed join (literal + interpolation branches) returned from a
	// function: the join is normalized per-branch (non-owned values strdup'd
	// into the join slot) and the owned result returned directly on both
	// backends.
	test("return match with mixed literal + interpolated string branches", async () => {
		const input = `
enum Result {
  case ok(int value)
  case error(string message)
}

func describe = (Result r, out string) {
    return match r {
        case .ok(n) -> "ok \\{n}"
        case .error -> "err"
    }
}

Console.write(describe(.ok(7)))
Console.write("\\n")
Console.write(describe(.error("nope")))
Console.write("\\n")
`;
		await build_and_check_output(input, "match_return_mixed", "ok 7\nerr\n");
	});

	test("match on struct field that is an enum with data", async () => {
		// Assigning a wide (multi-word) enum value to a struct field must
		// struct-copy the full value, not just store the RHS temp's address;
		// otherwise matching the field reads a garbage tag.
		const input = `
enum Len {
  case auto
  case fixed(int pixels)
}
struct LP {
  var Len width = .auto
}
var LP p = LP()
p.width = Len.fixed(50)
match p.width {
  case .auto -> Console.write("auto")
  case .fixed(n) -> Console.write("fixed \\{n}")
}
`;
		await build_and_check_output(input, "match_field_enum_with_data", "fixed 50");
	});
});

// ERRORS
describe("match errors", () => {
	test("type mismatch case vs value", () => {
		const input = `
func test = (out int) {
	const x = 5
	match x {
		case "hello" {
		}
		else {
		}
	}
	return 0
}
`;
		const expected = [
			test_error(input, "Match case type string does not match value type int", 5, 8),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("non-exhaustive enum match", () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

func main = () {
  var direction = Direction.north
  match direction {
    case .north {
      Console.write("north")
    }
    case .south {
      Console.write("south")
    }
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Non-exhaustive match");
		expect(parsed.errors[0].message).toContain("east");
		expect(parsed.errors[0].message).toContain("west");
	});

	test("exhaustive enum match with all cases", () => {
		const input = `
enum Direction {
  case north
  case south
}

func main = () {
  var direction = Direction.north
  match direction {
    case .north {
      Console.write("north")
    }
    case .south {
      Console.write("south")
    }
  }
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("exhaustive enum match with else", () => {
		const input = `
enum Direction {
  case north
  case south
  case east
}

func main = () {
  var direction = Direction.north
  match direction {
    case .north {
      Console.write("north")
    }
    else {
      Console.write("other")
    }
  }
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("non-exhaustive bool match", () => {
		const input = `
func main = () {
  var bool flag = true
  match flag {
    case true {
      Console.write("yes")
    }
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Non-exhaustive match");
		expect(parsed.errors[0].message).toContain("false");
	});

	test("exhaustive bool match", () => {
		const input = `
func main = () {
  var bool flag = true
  match flag {
    case true {
      Console.write("yes")
    }
    case false {
      Console.write("no")
    }
  }
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("int match requires else branch", () => {
		const input = `
func main = () {
  var int x = 5
  match x {
    case 1 {
      Console.write("one")
    }
    case 2 {
      Console.write("two")
    }
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Non-exhaustive match");
		expect(parsed.errors[0].message).toContain("else");
	});

	test("enum match with full form cases", () => {
		const input = `
enum Direction {
  case north
  case south
  case east
}

func main = () {
  var direction = Direction.north
  match direction {
    case Direction.north {
      Console.write("north")
    }
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Non-exhaustive match");
		expect(parsed.errors[0].message).toContain("south");
		expect(parsed.errors[0].message).toContain("east");
	});
});
