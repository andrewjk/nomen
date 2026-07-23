import { expect, test } from "vite-plus/test";

//import test_error from "../test_error";
import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// Because they can suspend and resume, async Zig functions are
// an example of a more general programming concept called
// "coroutines". One of the neat things about Zig async functions
// is that they retain their state as they are suspended and
// resumed.
//
// See if you can make this program print "5 4 3 2 1".
//
const print = @import("std").debug.print;

pub fn main() void {
    const n = 5;
    var foo_frame = async foo(n);

    ???

    print("\\n", .{});
}

fn foo(countdown: u32) void {
    var current = countdown;

    while (current > 0) {
        print("{} ", .{current});
        current -= 1;
        suspend {}
    }
}
`;

test.skip("ziglings 086 async3 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 086 async3 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 086 async3 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "0863", "");
});
