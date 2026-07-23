import { expect, test } from "vite-plus/test";

//import test_error from "../test_error";
import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// You can assign some code to run _after_ a block of code exits by
// deferring it with a "defer" statement:
//
//     {
//         defer runLater();
//         runNow();
//     }
//
// In the example above, runLater() will run when the block ({...})
// is finished. So the code above will run in the following order:
//
//     runNow();
//     runLater();
//
// This feature seems strange at first, but we'll see how it could be
// useful in the next exercise.
const std = @import("std");

pub fn main() void {
    // Without changing anything else, please add a 'defer' statement
    // to this code so that our program prints "One Two\\n":
    std.debug.print("Two\\n", .{});
    std.debug.print("One ", .{});
}
`;

test.skip("ziglings 027 defer -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 027 defer -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 027 defer -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "027", "");
});
