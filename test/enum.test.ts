import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

describe("enum build", () => {
	test("simple enum usage", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

var direction = Direction.north
Console.write("\\{direction}")
`;
		await build_and_check_output(input, "enum_simple", "0");
	});

	test("enum access different cases", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

const d = Direction.south
Console.write("\\{d}")
`;
		await build_and_check_output(input, "enum_different_case", "1");
	});

	test("enum with associated data", async () => {
		const input = `
enum Result {
  case ok
  case error(int code)
}

var result = Result.error(42)
Console.write("\\{result}")
`;
		await build_and_check_output(input, "enum_associated", "1");
	});

	test("reassign enum variable", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

var direction = Direction.north
direction = Direction.south
Console.write("\\{direction}")
`;
		await build_and_check_output(input, "enum_reassign", "1");
	});

	test("compare enum with equals", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

var direction = Direction.north
if direction == Direction.north {
  Console.write("north")
} else {
  Console.write("other")
}
`;
		await build_and_check_output(input, "enum_compare_equals", "north");
	});

	test("compare enum with not equals", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

var direction = Direction.south
if direction != Direction.north {
  Console.write("not north")
} else {
  Console.write("north")
}
`;
		await build_and_check_output(input, "enum_compare_not_equals", "not north");
	});

	test("enum in if else expression", async () => {
		const input = `
enum Direction {
  case north
  case south
}

var direction = Direction.north
const label = if direction == Direction.north -> "N"
              else -> "S"
Console.write(label)
`;
		await build_and_check_output(input, "enum_if_expression", "N");
	});

	test("multiple enums in same scope", async () => {
		const input = `
enum Color {
  case red
  case green
  case blue
}

enum Size {
  case small
  case large
}

var color = Color.green
var size = Size.large
if color == Color.green {
  Console.write("green")
}
if size == Size.large {
  Console.write("large")
}
`;
		await build_and_check_output(input, "enum_multiple", "greenlarge");
	});

	test("pub enum", async () => {
		const input = `
pub enum Status {
  case active
  case inactive
}

var s = Status.active
Console.write("\\{s}")
`;
		await build_and_check_output(input, "enum_pub", "0");
	});

	test("enum with multiple associated data fields", async () => {
		const input = `
enum Shape {
  case circle(int radius)
  case rect(int width, int height)
}

var shape = Shape.rect(10, 20)
Console.write("\\{shape}")
`;
		await build_and_check_output(input, "enum_multi_associated", "1");
	});

	test("enum with all cases having data", async () => {
		const input = `
enum Message {
  case quit
  case move(int x, int y)
  case write(string text)
}

var msg = Message.quit
Console.write("\\{msg}")
`;
		await build_and_check_output(input, "enum_all_data_cases", "0");
	});

	test("enum change and check", async () => {
		const input = `
enum TrafficLight {
  case red
  case yellow
  case green
}

var light = TrafficLight.red
if light == TrafficLight.red {
  light = TrafficLight.green
}
if light == TrafficLight.green {
  Console.write("go")
} else {
  Console.write("stop")
}
`;
		await build_and_check_output(input, "enum_change_and_check", "go");
	});

	test("enum shorthand in var declaration", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

var Direction dir = .east
Console.write("\\{dir}")
`;
		await build_and_check_output(input, "enum_shorthand_decl", "2");
	});

	test("enum shorthand in assignment", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

var direction = Direction.north
direction = .south
Console.write("\\{direction}")
`;
		await build_and_check_output(input, "enum_shorthand_assign", "1");
	});

	test("enum shorthand in comparison", async () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

var direction = Direction.north
if direction == .north {
  Console.write("north")
} else {
  Console.write("other")
}
`;
		await build_and_check_output(input, "enum_shorthand_compare", "north");
	});

	test("enum shorthand in if expression", async () => {
		const input = `
enum Direction {
  case north
  case south
}

var direction = Direction.north
const label = if direction == .north -> "N"
              else -> "S"
Console.write(label)
`;
		await build_and_check_output(input, "enum_shorthand_if_expr", "N");
	});

	test("enum shorthand C output", () => {
		const input = `
enum Direction {
  case north
  case south
  case east
  case west
}

func main = () {
  var Direction dir = .east
  if dir == .south {
    Console.write("south")
  }
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "c" });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("Direction_east");
		expect(result.code).toContain("Direction_south");
	});

	test("shorthand enum-with-args assignment (.fixed(50))", async () => {
		const input = `
enum Len {
  case auto
  case fixed(int pixels)
}

var Len w = .auto
w = .fixed(50)
Console.write("\\{w}")
`;
		await build_and_check_output(input, "enum_shorthand_with_args_assign", "1");
	});

	test("reassign enum local to a different associated-data case", async () => {
		const input = `
enum Len {
  case auto
  case fixed(int pixels)
}

var Len w = .auto
w = Len.fixed(50)
Console.write("\\{w}")
`;
		await build_and_check_output(input, "enum_reassign_associated_case", "1");
	});

	test("reassign enum and read payload via match", async () => {
		const input = `
enum Len {
  case auto
  case fixed(int pixels)
}

var Len w = .auto
w = Len.fixed(50)
Console.write("\\{w}")
var int n = match w {
  case .fixed(x) -> x
  else -> 0
}
Console.write("\\{n}")
`;
		await build_and_check_output(input, "enum_reassign_match_payload", "150");
	});

	test("enum with associated data as struct field default", async () => {
		const input = `
enum Align {
  case start
  case center
  case end
  case stretch
}

struct Box {
  pub var Align a = .stretch
}

var Box b = Box()
Console.write("\\{b.a}")
`;
		await build_and_check_output(input, "enum_field_default", "3");
	});

	test("compare enum with associated data against case constructor", async () => {
		const input = `
enum Result {
  case ok
  case error(int code)
}

var Result r = Result.error(42)
if r == Result.error(5) {
  Console.write("error")
} else {
  Console.write("other")
}
`;
		await build_and_check_output(input, "enum_data_compare_equals", "error");
	});

	test("compare enum with associated data against no-payload case", async () => {
		const input = `
enum Result {
  case ok
  case error(int code)
}

var Result r = Result.error(42)
if r == Result.ok {
  Console.write("ok")
} else {
  Console.write("error")
}
`;
		await build_and_check_output(input, "enum_data_compare_no_payload", "error");
	});

	test("compare enum with associated data with not equals", async () => {
		const input = `
enum Result {
  case ok
  case error(int code)
}

var Result r = Result.ok
if r != Result.error(1) {
  Console.write("not error")
} else {
  Console.write("error")
}
`;
		await build_and_check_output(input, "enum_data_compare_not_equals", "not error");
	});

	test("enum with associated data equality compares tags only", async () => {
		const input = `
enum Result {
  case ok
  case error(int code)
}

if Result.error(1) == Result.error(2) {
  Console.write("same case")
} else {
  Console.write("different")
}
`;
		await build_and_check_output(input, "enum_data_compare_tag_only", "same case");
	});

	test("compare enum with associated data via shorthand", async () => {
		const input = `
enum Result {
  case ok
  case error(int code)
}

var Result r = Result.error(7)
if r == .error(0) {
  Console.write("error")
} else {
  Console.write("other")
}
`;
		await build_and_check_output(input, "enum_data_compare_shorthand", "error");
	});

	test("compare two enum with associated data variables", async () => {
		const input = `
enum Result {
  case ok
  case error(int code)
}

var Result a = Result.error(1)
var Result b = Result.error(2)
var Result c = Result.ok
if a == b {
  Console.write("ab same")
}
if a != c {
  Console.write("ac differ")
}
`;
		await build_and_check_output(input, "enum_data_compare_variables", "ab sameac differ");
	});

	test("compare enum with associated data with case on left side", async () => {
		const input = `
enum Result {
  case ok
  case error(int code)
}

var Result r = Result.error(42)
if Result.ok == r {
  Console.write("ok")
} else {
  Console.write("error")
}
`;
		await build_and_check_output(input, "enum_data_compare_case_left", "error");
	});

	test("compare generic enum with associated data", async () => {
		const input = `
var Option<int> found = Option.some(4)
if found == Option.none {
  Console.write("none")
} else {
  Console.write("some")
}
if found == .some(0) {
  Console.write("same case")
}
`;
		await build_and_check_output(input, "enum_data_compare_generic", "somesame case");
	});
});

describe("enum declaration order", () => {
	// These exercise types declared NESTED inside main (the parse_with_imports
	// wrapping): a monomorphized generic enum hoisted to root scope must not
	// have its typedef emitted before the nested types it embeds by value.

	test("mono enum with nested enum payload", async () => {
		const input = `
enum Color {
  case red
  case green
}

enum Option<T> {
  case some(T value)
  case none
}

var Option<Color> o = Option.some(Color.red)
const label = match o {
  case .some(c) -> "some"
  case .none -> "none"
}
Console.write(label)
`;
		await build_and_check_output(input, "enum_mono_nested_enum_payload", "some");
	});

	test("mono enum with nested struct payload", async () => {
		const input = `
struct Point {
  var int x
  var int y
}

enum Option<T> {
  case some(T value)
  case none
}

var Option<Point> o = Option.some(Point(1, 2))
const label = match o {
  case .some(p) -> "some"
  case .none -> "none"
}
Console.write(label)
`;
		await build_and_check_output(input, "enum_mono_nested_struct_payload", "some");
	});

	test("mono enum with nested bitset payload", async () => {
		const input = `
bitset Flags {
  case a
  case b
}

enum Option<T> {
  case some(T value)
  case none
}

var Option<Flags> o = Option.some(Flags.a)
const label = match o {
  case .some(f) -> "some"
  case .none -> "none"
}
Console.write(label)
`;
		await build_and_check_output(input, "enum_mono_nested_bitset_payload", "some");
	});
});

describe("enum errors", () => {
	test("enum without braces", () => {
		const input = `
enum Direction
`;
		const expected = [test_error(input, "Expected token", 3, 0)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown enum case", () => {
		const input = `
enum Direction {
  case north
  case south
}

func main = () {
  var d = Direction.west
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Unknown enum case");
	});

	test("shorthand without type hint", () => {
		const input = `
enum Direction {
  case north
  case south
}

func main = () {
  var d = .north
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Cannot resolve .north without a type hint");
	});

	test("shorthand with wrong case name", () => {
		const input = `
enum Direction {
  case north
  case south
}

func main = () {
  var Direction d = .west
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Unknown enum case");
	});
});
