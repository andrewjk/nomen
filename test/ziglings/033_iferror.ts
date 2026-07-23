import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// Let's revisit the very first error exercise. This time, we're going to
// look at an error-handling variation of the "if" statement.
//
//     if (foo) |value| {
//
//         // foo was NOT an error; value is the non-error value of foo
//
//     } else |err| {
//
//         // foo WAS an error; err is the error value of foo
//
//     }
//
// We'll take it even further and use a switch statement to handle
// the error types.
//
//     if (foo) |value| {
//         ...
//     } else |err| switch(err) {
//         ...
//     }
//
const MyNumberError = error{
    TooBig,
    TooSmall,
};

const std = @import("std");

pub fn main() void {
    const nums = [_]u8{ 2, 3, 4, 5, 6 };

    for (nums) |num| {
        std.debug.print("{}", .{num});

        const n = numberMaybeFail(num);
        if (n) |value| {
            std.debug.print("={}. ", .{value});
        } else |err| switch (err) {
            MyNumberError.TooBig => std.debug.print(">4. ", .{}),
            // Please add a match for TooSmall here and have it print: "<4. "
        }
    }

    std.debug.print("\\n", .{});
}

// This time we'll have numberMaybeFail() return an error union rather
// than a straight error.
fn numberMaybeFail(n: u8) MyNumberError!u8 {
    if (n > 4) return MyNumberError.TooBig;
    if (n < 4) return MyNumberError.TooSmall;
    return n;
}
`;

test.skip("ziglings 033 iferror -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 033 iferror -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 033 iferror -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("033", built, "");
});
