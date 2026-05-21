import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Now let's use pointers to do something we haven't been
// able to do before: pass a value by reference to a function.
//
// Why would we wish to pass a pointer to an integer variable
// rather than the integer value itself? Because then we are
// allowed to *change* the value of the variable!
//
//     +-----------------------------------------------+
//     | Pass by reference when you want to change the |
//     | pointed-to value. Otherwise, pass the value.  |
//     +-----------------------------------------------+
//
const std = @import("std");

pub fn main() void {
    var num: u8 = 1;
    var more_nums = [_]u8{ 1, 1, 1, 1 };

    // Let's pass the num reference to our function and print it:
    makeFive(&num);
    std.debug.print("num: {}, ", .{num});

    // Now something interesting. Let's pass a reference to a
    // specific array value:
    makeFive(&more_nums[2]);

    // And print the array:
    std.debug.print("more_nums: ", .{});
    for (more_nums) |n| {
        std.debug.print("{} ", .{n});
    }

    std.debug.print("\\n", .{});
}

// This function should take a reference to a u8 value and set it
// to 5.
fn makeFive(x: *u8) void {
    ??? = 5; // fix me!
}
`;

test.skip("ziglings 042 pointers4 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 042 pointers4 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 042 pointers4 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0424", built, "");
});
