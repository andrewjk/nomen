import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// ------------------------------------------------------------
//  TOP SECRET  TOP SECRET  TOP SECRET  TOP SECRET  TOP SECRET
// ------------------------------------------------------------
//
// Are you ready for the THE TRUTH about Zig string literals?
//
// Here it is:
//
//     @TypeOf("foo") == *const [3:0]u8
//
// Which means a string literal is a "constant pointer to a
// zero-terminated (null-terminated) fixed-size array of u8".
//
// Now you know. You've earned it. Welcome to the secret club!
//
// ------------------------------------------------------------
//
// Why do we bother using a zero/null sentinel to terminate
// strings in Zig when we already have a known length?
//
// Versatility! Zig strings are compatible with C strings (which
// are null-terminated) AND can be coerced to a variety of other
// Zig types:
//
//     const a: [5]u8 = "array".*;
//     const b: *const [16]u8 = "pointer to array";
//     const c: []const u8 = "slice";
//     const d: [:0]const u8 = "slice with sentinel";
//     const e: [*:0]const u8 = "many-item pointer with sentinel";
//     const f: [*]const u8 = "many-item pointer";
//
// All but 'f' may be printed. (A many-item pointer without a
// sentinel is not safe to print because we don't know where it
// ends!)
//
const print = @import("std").debug.print;

const WeirdContainer = struct {
    data: [*]const u8,
    length: usize,
};

pub fn main() void {
    // WeirdContainer is an awkward way to house a string.
    //
    // Being a many-item pointer (with no sentinel termination),
    // the 'data' field "loses" the length information AND the
    // sentinel termination of the string literal "Weird Data!".
    //
    // Luckily, the 'length' field makes it possible to still
    // work with this value.
    const foo = WeirdContainer{
        .data = "Weird Data!",
        .length = 11,
    };

    // How do we get a printable value from 'foo'? One way is to
    // turn it into something with a known length. We do have a
    // length... You've actually solved this problem before!
    //
    // Here's a big hint: do you remember how to take a slice?
    const printable = ???;

    print("{s}\\n", .{printable});
}
`;

test.skip("ziglings 077 sentinels2 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 077 sentinels2 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 077 sentinels2 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0772", built, "");
});
