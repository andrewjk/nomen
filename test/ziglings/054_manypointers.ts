import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// You can also make pointers to multiple items without using a slice.
//
//     var foo: [4]u8 = [4]u8{ 1, 2, 3, 4 };
//     var foo_slice: []u8 = foo[0..];
//     var foo_ptr: [*]u8 = &foo;
//     var foo_slice_from_ptr: []u8 = foo_ptr[0..4];
//
// The difference between foo_slice and foo_ptr is that the slice has
// a known length. The pointer doesn't. It is up to YOU to keep track
// of the number of u8s foo_ptr points to!
//
const std = @import("std");

pub fn main() void {
    // Take a good look at the array type to which we're coercing
    // the zen12 string (the REAL nature of strings will be
    // revealed when we've learned some additional features):
    const zen12: *const [21]u8 = "Memory is a resource.";
    //
    //   It would also have been valid to coerce to a slice:
    //         const zen12: []const u8 = "...";
    //
    // Now let's turn this into a "many-item pointer":
    const zen_manyptr: [*]const u8 = zen12;

    // It's okay to access zen_manyptr just like an array or slice as
    // long as you keep track of the length yourself!
    //
    // A "string" in Zig is a pointer to an array of const u8 values
    // (or a slice of const u8 values, as we saw above). So, we could
    // treat a "many-item pointer" of const u8 as a string as long as
    // we can CONVERT IT TO A SLICE. (Hint: we do know the length!)
    //
    // Please fix this line so the print statement below can print it:
    const zen12_string: []const u8 = zen_manyptr;

    // Here's the moment of truth!
    std.debug.print("{s}\\n", .{zen12_string});
}
//
// Are all of these pointer types starting to get confusing?
//
//     FREE ZIG POINTER CHEATSHEET! (Using u8 as the example type.)
//   +---------------+----------------------------------------------+
//   |  u8           |  one u8                                      |
//   |  *u8          |  pointer to one u8                           |
//   |  [2]u8        |  two u8s                                     |
//   |  [*]u8        |  pointer to unknown number of u8s            |
//   |  [*]const u8  |  pointer to unknown number of immutable u8s  |
//   |  *[2]u8       |  pointer to an array of 2 u8s                |
//   |  *const [2]u8 |  pointer to an immutable array of 2 u8s      |
//   |  []u8         |  slice of u8s                                |
//   |  []const u8   |  slice of immutable u8s                      |
//   +---------------+----------------------------------------------+
`;

test.skip("ziglings 054 manypointers -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 054 manypointers -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 054 manypointers -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("054", built, "");
});
