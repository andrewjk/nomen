import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Great news! Now we know enough to understand a "real" Hello World
// program in Zig - one that uses the system Standard Out resource...which
// can fail!
//
const std = @import("std");

// Take note that this main() definition now returns "!void" rather
// than just "void". Since there's no specific error type, this means
// that Zig will infer the error type. This is appropriate in the case
// of main(), but can make a function harder (function pointers) or
// even impossible to work with (recursion) in some situations.
//
// You can find more information at:
// https://ziglang.org/documentation/master/#Inferred-Error-Sets
//
pub fn main() !void {
    // We get a Writer for Standard Out so we can print() to it.
    const stdout = std.io.getStdOut().writer();

    // Unlike std.debug.print(), the Standard Out writer can fail
    // with an error. We don't care _what_ the error is, we want
    // to be able to pass it up as a return value of main().
    //
    // We just learned of a single statement which can accomplish this.
    stdout.print("Hello world!\\n", .{});
}
`;

test.skip("ziglings 026 hello2 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 026 hello2 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 026 hello2 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0262", built, "");
});
