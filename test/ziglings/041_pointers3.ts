import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// The tricky part is that the pointer's mutability (var vs const) refers
// to the ability to change what the pointer POINTS TO, not the ability
// to change the VALUE at that location!
//
//     const locked: u8 = 5;
//     var unlocked: u8 = 10;
//
//     const p1: *const u8 = &locked;
//     var   p2: *const u8 = &locked;
//
// Both p1 and p2 point to constant values which cannot change. However,
// p2 can be changed to point to something else and p1 cannot!
//
//     const p3: *u8 = &unlocked;
//     var   p4: *u8 = &unlocked;
//     const p5: *const u8 = &unlocked;
//     var   p6: *const u8 = &unlocked;
//
// Here p3 and p4 can both be used to change the value they point to but
// p3 cannot point at anything else.
// What's interesting is that p5 and p6 act like p1 and p2, but point to
// the value at "unlocked". This is what we mean when we say that we can
// make a constant reference to any value!
//
const std = @import("std");

pub fn main() void {
    var foo: u8 = 5;
    var bar: u8 = 10;

    // Please define pointer "p" so that it can point to EITHER foo or
    // bar AND change the value it points to!
    ??? p: ??? = undefined;

    p = &foo;
    p.* += 1;
    p = &bar;
    p.* += 1;
    std.debug.print("foo={}, bar={}\\n", .{ foo, bar });
}
`;

test.skip("ziglings 041 pointers3 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 041 pointers3 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 041 pointers3 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0413", built, "");
});
