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
} else {
		Console.write("other")
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
} else {
		result = 0
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
} else {
		Console.write("other")
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
} else {
		Console.write("other")
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
} else {
		Console.write("other")
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
} else {
		Console.write("other")
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
} else -> "other"
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
} else -> "other"
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
} else {
		result = 0
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
		} else {
				result = 2
			}
	}
} else {
		result = 0
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
	} else {
			result = result + 1
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
} else -> 0
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
} else {
		result = 3
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
} else {
		result = 3
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
} else {
		result = 2
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
} else {
		Console.write("other")
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
} else -> "?"
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
} else -> 0
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
mv enum Result {
  case ok(int value)
  case fail(string message)
}

var Result r = .ok(5)
const m = match r {
	case .ok(n) -> "ok \\{n}"
	case .fail(e) -> "err \\{e}"
}
Console.write(m)
Console.write("\\n")

var Result r2 = .fail("bad")
const m2 = match r2 {
	case .ok(n) -> "ok \\{n}"
	case .fail(e) -> "err \\{e}"
}
Console.write(m2)
Console.write("\\n")
`;
		await build_and_check_output(input, "match_expr_interp", "ok 5\nerr bad\n");
	});

	test("match-as-expression with multiple interpolations per branch", async () => {
		const input = `
mv enum Result {
  case ok(int value)
  case fail(string message)
}

var Result r = .ok(5)
const m = match r {
	case .ok(n) -> "ok \\{n} \\{n + 1}"
	case .fail(e) -> "err \\{e}"
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
mv enum Result {
  case ok(int value)
  case fail(string message)
}

func describe = (Result r, out string) {
    return match r {
        case .ok(n) -> "ok \\{n}"
        case .fail(e) -> "err \\{e}"
    }
}

Console.write(describe(.ok(7)))
Console.write("\\n")
Console.write(describe(.fail("nope")))
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
mv enum Result {
  case ok(int value)
  case fail(string message)
}

var Result r = .ok(5)
const m = match r {
	case .ok(n) -> "ok \\{n}"
	case .fail -> "err"
}
Console.write(m)
Console.write("\\n")

var Result r2 = .fail("bad")
const m2 = match r2 {
	case .ok(n) -> "ok \\{n}"
	case .fail -> "err"
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
mv enum Result {
  case ok(int value)
  case fail(string message)
}

var Result r = .ok(5)
const m = match r {
	case .fail -> "err"
	case .ok(n) -> "ok \\{n}"
}
Console.write(m)
Console.write("\\n")

var Result r2 = .fail("bad")
const m2 = match r2 {
	case .fail -> "err"
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
mv enum Result {
  case ok(int value)
  case fail(string message)
}

func describe = (Result r, out string) {
    return match r {
        case .ok(n) -> "ok \\{n}"
        case .fail -> "err"
    }
}

Console.write(describe(.ok(7)))
Console.write("\\n")
Console.write(describe(.fail("nope")))
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
	} else {
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
  } else {
      Console.write("other")
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

// Regression (aarch64): the match-expression branch result is stored into a
// join slot — the store must carry BOTH halves of a fat string. The join
// target is not in scoped_declarations (the arms swap the frame out), so the
// size lookup fell back to 8 and the len half was left as garbage in the
// slot; a user-function call arg reloads the pair (ptr, len) and got a
// corrupt length.
test("match result as user-function call arg (fat pair join)", async () => {
	const input = `
func shout = (string msg, out string) {
	return msg + "!!"
}

var int n = 42
Console.write_line(shout(match true {
	case true -> n.to_string()
	case false -> n.to_string()
}))
`;
	await build_and_check_output(input, "match_call_arg_pair", "42!!\n");
});

// Regression (C): a match on the RHS of a REASSIGNMENT lowered the C `switch`
// statement into the initializer expression position (clang: "expected
// expression"). Lower it through a join temp like the declaration path.
test("match as reassignment RHS (C switch statement)", async () => {
	const input = `
var int n = 42
var string m = "x"
m = match true {
	case true -> n.to_string()
	case false -> n.to_string()
}
Console.write_line(m)
`;
	await build_and_check_output(input, "match_reassign_join", "42\n");
});

// Regression (both backends): a match assigned to a SCALAR local emitted the
// C `switch` statement into expression position (invalid C), and on aarch64
// the match epilogue's scrutinee cleanup clobbered x0 so the destination
// received the taken case's tag as a byte (a stray \u0001). Both lower the
// RHS through a join temp now.
test("a match assigned to an int local", async () => {
	const input = `
enum Pick {
	case one
	case two
}

func pick = (out Pick) {
	return .two
}

func main_test = (out int) {
	var n = 0
	n = match pick() {
		case .one -> 11
		case .two -> 22
	}
	return n
}

Console.write("\\{main_test()}\\n")
`;
	await build_and_check_output(input, "match_reassign_int", "22\n");
});

test("a switch assigned to an int local", async () => {
	const input = `
func main_test = (out int) {
	var x = 2
	var n = 0
	n = switch {
		case x > 5 -> 11
		case x > 1 -> 22
	} else -> 0
	return n
}

Console.write("\\{main_test()}\\n")
`;
	await build_and_check_output(input, "switch_reassign_int", "22\n");
});

test("an if assigned to an int local", async () => {
	const input = `
func main_test = (out int) {
	var n = 0
	n = if 2 > 1 -> 22 else -> 11
	return n
}

Console.write("\\{main_test()}\\n")
`;
	await build_and_check_output(input, "if_reassign_int", "22\n");
});

// Regression (aarch64): a match with a CALL scrutinee assigned to a string
// local stored the scrutinee temp's address as the pair — the epilogue's
// payload cleanup clobbered x0/x1 before the store. Join the branches into a
// frame temp like the return path.
test("a match assigned to a string local with a call scrutinee", async () => {
	const input = `
func load = (string path, out Result<string, string>) {
	if path == "/x" {
		return .ok("real")
	}
	return .fail("nope")
}

func main_test = (out string) {
	var label = "init"
	label = match load("/x") {
		case .ok(text) -> text
		case .fail(err) -> "missing"
	}
	return label
}

Console.write("\\{main_test()}\\n")
`;
	await build_and_check_output(input, "match_reassign_string_call", "real\n");
});

test("a match assigned to a string field", async () => {
	const input = `
mv struct Holder {
	mv string label
}

func main_test = (out string) {
	var h = Holder("init")
	h.label = match 1 {
		case 0 -> "zero"
		case 1 -> "one"
	} else -> "other"
	return h.label.copy()
}

Console.write("\\{main_test()}\\n")
`;
	await build_and_check_output(input, "match_reassign_field", "one\n");
});

// Struct-kind destinations (value structs, mv structs, enums with data,
// nullable slots, container monos): the arms leave the value's ADDRESS (or
// handle) in x0 and the join lands through a frame temp / the join slot —
// declaration position on aarch64 used to land partial garbage (the match
// epilogue's clobbered scratch read as the copy source), and reassignment
// emitted the branch statement into expression position (C: invalid) or
// stored the clobbered x0 (aarch64).
describe("match as a struct/enum destination value", () => {
	test("a struct match in declaration position", async () => {
		const input = `
struct Point {
	var int x
	var int y
}

func pick = (out Result<Point, string>) {
	return .ok(Point(3, 4))
}

func main_test = (out int) {
	var p = Point(0, 0)
	var q = match pick() {
		case .ok(pt) -> pt
		case .fail(_) -> Point(9, 9)
	}
	return q.x + q.y
}

Console.write("\\{main_test()}\\n")
`;
		await build_and_check_output(input, "match_decl_struct", "7\n");
	});

	test("a struct match reassigned to a local", async () => {
		const input = `
struct Point {
	var int x
	var int y
}

func pick = (out Result<Point, string>) {
	return .ok(Point(3, 4))
}

func main_test = (out int) {
	var p = Point(0, 0)
	p = match pick() {
		case .ok(pt) -> pt
		case .fail(_) -> Point(9, 9)
	}
	return p.x + p.y
}

Console.write("\\{main_test()}\\n")
`;
		await build_and_check_output(input, "match_reassign_struct", "7\n");
	});

	test("an mv-struct match reassigned to a local", async () => {
		const input = `
mv struct Box {
	var int value
}

func pick = (out Result<Box, string>) {
	return .ok(Box(5))
}

func main_test = (out int) {
	var b = Box(1)
	b = match pick() {
		case .ok(box) -> box
		case .fail(_) -> Box(9)
	}
	return b.value
}

Console.write("\\{main_test()}\\n")
`;
		await build_and_check_output(input, "match_reassign_mvstruct", "5\n");
	});

	test("an enum-with-data match reassigned to a local", async () => {
		const input = `
error LoadError {
	case timeout(int ms)
	case refused
}

func pick = (int n, out Result<int, LoadError>) {
	if n == 0 {
		return .fail(.timeout(50))
	}
	return .ok(1)
}

func main_test = (out int) {
	var e = LoadError.refused
	e = match pick(0) {
		case .ok(_) -> LoadError.refused
		case .fail(err) -> err
	}
	match e {
		case .timeout(ms) -> Console.write("timeout \\{ms}\\n")
		case .refused -> Console.write("refused\\n")
	}
	return 0
}

Console.write("\\{main_test()}\\n")
`;
		await build_and_check_output(input, "match_reassign_enum_data", "timeout 50\n");
	});

	test("a match assigned to a scalar field", async () => {
		const input = `
struct Holder {
	var int count
}

func main_test = (out int) {
	var h = Holder(0)
	h.count = match 1 {
		case 0 -> 10
		case 1 -> 20
	} else -> 0
	return h.count
}

Console.write("\\{main_test()}\\n")
`;
		await build_and_check_output(input, "match_reassign_scalar_field", "20\n");
	});

	test("a match assigned to a struct field", async () => {
		const input = `
struct Point {
	var int x
	var int y
}

struct Holder {
	var Point pt
}

func main_test = (out int) {
	var h = Holder(Point(0, 0))
	h.pt = match 1 {
		case 0 -> Point(1, 1)
		case 1 -> Point(3, 4)
	} else -> Point(0, 0)
	return h.pt.x + h.pt.y
}

Console.write("\\{main_test()}\\n")
`;
		await build_and_check_output(input, "match_reassign_struct_field", "7\n");
	});

	test("a match assigned to a nullable scalar slot", async () => {
		const input = `
func main_test = (out int) {
	var int? n = null
	n = match 1 {
		case 0 -> 10
		case 1 -> 20
	} else -> 30
	return n ?? -1
}

Console.write("\\{main_test()}\\n")
`;
		await build_and_check_output(input, "match_reassign_nullable", "20\n");
	});

	test("a match assigned to a container-typed local", async () => {
		const input = `
func main_test = (out int) {
	var l = List<int>()
	l = match 1 {
		case 0 -> List<int>()
		case 1 -> List<int>()
	} else -> l
	return l.length
}

Console.write("\\{main_test()}\\n")
`;
		await build_and_check_output(input, "match_reassign_generic_local", "0\n");
	});
});
