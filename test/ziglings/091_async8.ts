import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// You have doubtless noticed that 'suspend' requires a block
// expression like so:
//
//     suspend {}
//
// The suspend block executes when a function suspends. To get
// sense for when this happens, please make the following
// program print the string
//
//     "ABCDEF"
//
const print = @import("std").debug.print;

pub fn main() void {
    print("A", .{});

    var frame = async suspendable();

    print("X", .{});

    resume frame;

    print("F", .{});
}

fn suspendable() void {
    print("X", .{});

    suspend {
        print("X", .{});
    }

    print("X", .{});
}
`;

test.skip("ziglings 091 async8 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 091 async8 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 091 async8 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0918", built, "");
});
