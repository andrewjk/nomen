import { expect, test } from "vite-plus/test";

//import test_error from "../test_error";
import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// Anonymous struct literal syntax can also be used to compose an
// "anonymous list" with an array type destination:
//
//     const foo: [3]u32 = .{10, 20, 30};
//
// Otherwise it's a "tuple":
//
//     const bar = .{10, 20, 30};
//
// The only difference is the destination type.
//
const print = @import("std").debug.print;

pub fn main() void {
    // Please make 'hello' a string-like array of u8 WITHOUT
    // changing the value literal.
    //
    // Don't change this part:
    //
    //     = .{ 'h', 'e', 'l', 'l', 'o' };
    //
    const hello = .{ 'h', 'e', 'l', 'l', 'o' };
    print("I say {s}!\\n", .{hello});
}
`;

test.skip("ziglings 083 anonymous lists -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 083 anonymous lists -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 083 anonymous lists -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "083", "");
});
