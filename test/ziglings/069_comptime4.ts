import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// One of the more common uses of 'comptime' function parameters is
// passing a type to a function:
//
//     fn foo(comptime MyType: type) void { ... }
//
// In fact, types are ONLY available at compile time, so the
// 'comptime' keyword is required here.
//
// Please take a moment to put on the wizard hat which has been
// provided for you. We're about to use this ability to implement
// a generic function.
//
const print = @import("std").debug.print;

pub fn main() void {
    // Here we declare arrays of three different types and sizes
    // at compile time from a function call. Neat!
    const s1 = makeSequence(u8, 3); // creates a [3]u8
    const s2 = makeSequence(u32, 5); // creates a [5]u32
    const s3 = makeSequence(i64, 7); // creates a [7]i64

    print("s1={any}, s2={any}, s3={any}\\n", .{ s1, s2, s3 });
}

// This function is pretty wild because it executes at runtime
// and is part of the final compiled program. The function is
// compiled with unchanging data sizes and types.
//
// And yet it ALSO allows for different sizes and types. This
// seems paradoxical. How could both things be true?
//
// To accomplish this, the Zig compiler actually generates a
// separate copy of the function for every size/type combination!
// So in this case, three different functions will be generated
// for you, each with machine code that handles that specific
// data size and type.
//
// Please fix this function so that the 'size' parameter:
//
//     1) Is guaranteed to be known at compile time.
//     2) Sets the size of the array of type T (which is the
//        sequence we're creating and returning).
//
fn makeSequence(comptime T: type, ??? size: usize) [???]T {
    var sequence: [???]T = undefined;
    var i: usize = 0;

    while (i < size) : (i += 1) {
        sequence[i] = @as(T, @intCast(i)) + 1;
    }

    return sequence;
}
`;

test.skip("ziglings 069 comptime4 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 069 comptime4 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 069 comptime4 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0694", built, "");
});
