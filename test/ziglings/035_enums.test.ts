import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Remember that little mathematical virtual machine we made using the
// "unreachable" statement?  Well, there were two problems with the
// way we were using op codes:
//
//   1. Having to remember op codes by number is no good.
//   2. We had to use "unreachable" because Zig had no way of knowing
//      how many valid op codes there were.
//
// An "enum" is a Zig construct that lets you give names to numeric
// values and store them in a set. They look a lot like error sets:
//
//     const Fruit = enum{ apple, pear, orange };
//
//     const my_fruit = Fruit.apple;
//
// Let's use an enum in place of the numbers we were using in the
// previous version!
//
const std = @import("std");

// Please complete the enum!
const Ops = enum { ??? };

pub fn main() void {
    const operations = [_]Ops{
        Ops.inc,
        Ops.inc,
        Ops.inc,
        Ops.pow,
        Ops.dec,
        Ops.dec,
    };

    var current_value: u32 = 0;

    for (operations) |op| {
        switch (op) {
            Ops.inc => {
                current_value += 1;
            },
            Ops.dec => {
                current_value -= 1;
            },
            Ops.pow => {
                current_value *= current_value;
            },
            // No "else" needed! Why is that?
        }

        std.debug.print("{} ", .{current_value});
    }

    std.debug.print("\\n", .{});
}
`;

test.skip("ziglings 035 enums -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 035 enums -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 035 enums -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("035", built, "");
});
