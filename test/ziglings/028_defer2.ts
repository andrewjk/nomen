import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// Now that you know how "defer" works, let's do something more
// interesting with it.
//
const std = @import("std");

pub fn main() void {
    const animals = [_]u8{ 'g', 'c', 'd', 'd', 'g', 'z' };

    for (animals) |a| printAnimal(a);

    std.debug.print("done.\\n", .{});
}

// This function is _supposed_ to print an animal name in parentheses
// like "(Goat) ", but we somehow need to print the end parenthesis
// even though this function can return in four different places!
fn printAnimal(animal: u8) void {
    std.debug.print("(", .{});

    std.debug.print(") ", .{}); // <---- how?!

    if (animal == 'g') {
        std.debug.print("Goat", .{});
        return;
    }
    if (animal == 'c') {
        std.debug.print("Cat", .{});
        return;
    }
    if (animal == 'd') {
        std.debug.print("Dog", .{});
        return;
    }

    std.debug.print("Unknown", .{});
}
`;

test.skip("ziglings 028 defer2 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 028 defer2 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 028 defer2 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0282", built, "");
});
