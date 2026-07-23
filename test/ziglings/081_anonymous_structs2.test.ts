import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// INCOMPATIBILITIES:
// - Zig uses `.field = value` anonymous struct literal syntax with `anytype` params.
//   Nomen uses `[ field = value ]` syntax with named struct params.
// - Zig's `@as(u32, 205)` for explicit type coercion. Nomen infers types from struct fields.

test("ziglings 081 anonymous structs2 -- errors", () => {
	const input = `
import System

struct Circle {
    var int center_x
    var int center_y
    var int radius
}

func printCircle = (Circle circle) {
    Console.write("x:\\{circle.center_x} y:\\{circle.center_y} radius:\\{circle.radius}\\n")
}

pub func main = () {
    printCircle([ center_x = ???, center_y = 187, radius = 12 ])
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 081 anonymous structs2 -- fixed", () => {
	const input = `
import System

struct Circle {
    var int center_x
    var int center_y
    var int radius
}

func printCircle = (Circle circle) {
    Console.write("x:\\{circle.center_x} y:\\{circle.center_y} radius:\\{circle.radius}\\n")
}

pub func main = () {
    printCircle([ center_x = 205, center_y = 187, radius = 12 ])
    return
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 081 anonymous structs2 -- build", async () => {
	const input = `
import System

struct Circle {
    var int center_x
    var int center_y
    var int radius
}

func printCircle = (Circle circle) {
    Console.write("x:\\{circle.center_x} y:\\{circle.center_y} radius:\\{circle.radius}\\n")
}

pub func main = () {
    printCircle([ center_x = 205, center_y = 187, radius = 12 ])
    return
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_0812", "x:205 y:187 radius:12\n", true);
});
