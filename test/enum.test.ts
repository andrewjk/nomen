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
