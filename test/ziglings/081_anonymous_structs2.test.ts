import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// INCOMPATIBILITIES:
// - Zig uses `.field = value` anonymous struct literal syntax with `anytype` params.
//   Echo uses `[ field = value ]` syntax with named struct params.
// - Zig's `@as(u32, 205)` for explicit type coercion. Echo infers types from struct fields.

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
    return
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
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0812", built, "x:205 y:187 radius:12\n");
});
