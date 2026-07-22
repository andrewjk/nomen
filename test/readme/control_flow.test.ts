import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("readme: control flow", () => {
	test("if/else, switch, match, while, for", () => {
		const input = `
enum Direction {
    case north
    case south
    case east
    case west
}

var int x = 5
var Direction direction = Direction.north
const int[] items = [1, 2, 3]

if x > 0 {
    Console.write("positive")
} else {
    Console.write("zero")
}

switch {
    case x > 100 -> Console.write("big")
    case x > 10 -> Console.write("medium")
    else -> Console.write("small")
}

const label = match direction {
    case .north -> "N"
    case .south -> "S"
    else -> "?"
}

while x < 10; x += 1 {
    Console.write("\\{x}")
}

for item of items {
    Console.write("\\{item}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});
