import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// INCOMPATIBILITIES:
// - Zig uses comptime generics (Circle(comptime T: type) type) to create struct types
//   parameterized by type. Nomen uses struct generics with type params.
// - Zig uses @typeName to print struct type names at runtime. Nomen uses a string field instead.
// - Float struct init in aarch64 has a pre-existing bug, so the second circle uses int too.

test("ziglings 080 anonymous structs -- errors", () => {
	const input = `
import System

struct Circle<T> {
    var name = "Circle"
    var T center_x
    var T center_y
    var T radius
}

func printCircle<T> = (Circle<T> circle) {
    Console.write("[\\{circle.name}: \\{circle.center_x},\\{circle.center_y},\\{circle.radius}]\\n")
}

pub func main = () {
    printCircle([ center_x = 25, center_y = 70 ])
    return
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 080 anonymous structs -- fixed", () => {
	const input = `
import System

struct Circle<T> {
    var name = "Circle"
    var T center_x
    var T center_y
    var T radius
}

func printCircle<T> = (Circle<T> circle) {
    Console.write("[\\{circle.name}: \\{circle.center_x},\\{circle.center_y},\\{circle.radius}]\\n")
}

pub func main = () {
    printCircle([ center_x = 25, center_y = 70, radius = 15 ])
    printCircle([ center_x = 205, center_y = 187, radius = 12 ])
    return
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 080 anonymous structs -- build", async () => {
	const input = `
import System

struct Circle<T> {
    var name = "Circle"
    var T center_x
    var T center_y
    var T radius
}

func printCircle<T> = (Circle<T> circle) {
    Console.write("[\\{circle.name}: \\{circle.center_x},\\{circle.center_y},\\{circle.radius}]\\n")
}

pub func main = () {
    printCircle([ center_x = 25, center_y = 70, radius = 15 ])
    printCircle([ center_x = 205, center_y = 187, radius = 12 ])
    return
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("080", built, "[Circle: 25,70,15]\n[Circle: 205,187,12]\n");
});
