import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// Sometimes you need to create an identifier that will not, for
// whatever reason, play by the naming rules:
//
//     const 55_cows: i32 = 55; // ILLEGAL: starts with a number
//     const isn't true: bool = false; // ILLEGAL: what even?!
//
// If you try to create either of these under normal
// circumstances, a special Program Identifier Syntax Security
// Team (PISST) will come to your house and take you away.
//
// Thankfully, Zig has a way to sneak these wacky identifiers
// past the authorities: the @"" identifier quoting syntax.
//
//     @"foo"
//
// Please help us safely smuggle these fugitive identifiers into
// our program:
//
const print = @import("std").debug.print;

pub fn main() void {
    const 55_cows: i32 = 55;
    const isn't true: bool = false;

    print("Sweet freedom: {}, {}.\\n", .{
        55_cows,
        isn't true,
    });
}
`;

test.skip("ziglings 079 quoted identifiers -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 079 quoted identifiers -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 079 quoted identifiers -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("079", built, "");
});
