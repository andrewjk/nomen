import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// It has probably not escaped your attention that we are no
// longer capturing a return value from foo() because the 'async'
// keyword returns the frame instead.
//
// One way to solve this is to use a global variable.
//
// See if you can make this program print "1 2 3 4 5".
//
const print = @import("std").debug.print;

var global_counter: i32 = 0;

pub fn main() void {
    var foo_frame = async foo();

    while (global_counter <= 5) {
        print("{} ", .{global_counter});
        ???
    }

    print("\\n", .{});
}

fn foo() void {
    while (true) {
        ???
        ???
    }
}
`;

test.skip("ziglings 087 async4 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 087 async4 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 087 async4 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0874", built, "");
});
