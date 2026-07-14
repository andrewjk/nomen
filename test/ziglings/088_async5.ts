import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Sure, we can solve our async value problem with a global
// variable. But this hardly seems like an ideal solution.
//
// So how do we REALLY get return values from async functions?
//
// The 'await' keyword waits for an async function to complete
// and then captures its return value.
//
//     fn foo() u32 {
//         return 5;
//     }
//
//    var foo_frame = async foo(); // invoke and get frame
//    var value = await foo_frame; // await result using frame
//
// The above example is just a silly way to call foo() and get 5
// back. But if foo() did something more interesting such as wait
// for a network response to get that 5, our code would pause
// until the value was ready.
//
// As you can see, async/await basically splits a function call
// into two parts:
//
//    1. Invoke the function ('async')
//    2. Getting the return value ('await')
//
// Also notice that a 'suspend' keyword does NOT need to exist in
// a function to be called in an async context.
//
// Please use 'await' to get the string returned by
// getPageTitle().
//
const print = @import("std").debug.print;

pub fn main() void {
    var myframe = async getPageTitle("http://example.com");

    var value = ???

    print("{s}\\n", .{value});
}

fn getPageTitle(url: []const u8) []const u8 {
    // Please PRETEND this is actually making a network request.
    _ = url;
    return "Example Title.";
}
`;

test.skip("ziglings 088 async5 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 088 async5 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 088 async5 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0885", built, "");
});
