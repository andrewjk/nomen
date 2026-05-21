import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// There have been several instances where it would have been
// nice to use loops in our programs, but we couldn't because the
// things we were trying to do could only be done at compile
// time. We ended up having to do those things MANUALLY, like
// NORMAL people. Bah! We are PROGRAMMERS! The computer should be
// doing this work.
//
// An 'inline for' is performed at compile time, allowing you to
// programatically loop through a series of items in situations
// like those mentioned above where a regular runtime 'for' loop
// wouldn't be allowed:
//
//     inline for (.{ u8, u16, u32, u64 }) |T| {
//         print("{} ", .{@typeInfo(T).Int.bits});
//     }
//
// In the above example, we're looping over a list of types,
// which are available only at compile time.
//
const print = @import("std").debug.print;

// Remember Narcissus from exercise 065 where we used builtins
// for reflection? He's back and loving it.
const Narcissus = struct {
    me: *Narcissus = undefined,
    myself: *Narcissus = undefined,
    echo: void = undefined,
};

pub fn main() void {
    print("Narcissus has room in his heart for:", .{});

    // Last time we examined the Narcissus struct, we had to
    // manually access each of the three fields. Our 'if'
    // statement was repeated three times almost verbatim. Yuck!
    //
    // Please use an 'inline for' to implement the block below
    // for each field in the slice 'fields'!

    const fields = @typeInfo(Narcissus).@"struct".fields;

    ??? {
        if (field.type != void) {
            print(" {s}", .{field.name});
        }
    }

    // Once you've got that, go back and take a look at exercise
    // 065 and compare what you've written to the abomination we
    // had there!

    print(".\\n", .{});
}
`;

test.skip("ziglings 071 comptime6 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 071 comptime6 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 071 comptime6 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0716", built, "");
});
