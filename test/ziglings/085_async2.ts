import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// So, 'suspend' returns control to the place from which it was
// called (the "call site"). How do we give control back to the
// suspended function?
//
// For that, we have a new keyword called 'resume' which takes an
// async function invocation's frame and returns control to it.
//
//     fn fooThatSuspends() void {
//         suspend {}
//     }
//
//     var foo_frame = async fooThatSuspends();
//     resume foo_frame;
//
// See if you can make this program print "Hello async!".
//
const print = @import("std").debug.print;

pub fn main() void {
    var foo_frame = async foo();
}

fn foo() void {
    print("Hello ", .{});
    suspend {}
    print("async!\\n", .{});
}
`;

test.skip("ziglings 085 async2 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 085 async2 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 085 async2 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0852", built, "");
});
