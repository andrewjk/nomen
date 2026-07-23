import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// The power and purpose of async/await becomes more apparent
// when we do multiple things concurrently. Foo and Bar do not
// depend on each other and can happen at the same time, but End
// requires that they both be finished.
//
//               +---------+
//               |  Start  |
//               +---------+
//                  /    \\
//                 /      \\
//        +---------+    +---------+
//        |   Foo   |    |   Bar   |
//        +---------+    +---------+
//                 \\      /
//                  \\    /
//               +---------+
//               |   End   |
//               +---------+
//
// We can express this in Zig like so:
//
//     fn foo() u32 { ... }
//     fn bar() u32 { ... }
//
//     // Start
//
//     var foo_frame = async foo();
//     var bar_frame = async bar();
//
//     var foo_value = await foo_frame;
//     var bar_value = await bar_frame;
//
//     // End
//
// Please await TWO page titles!
//
const print = @import("std").debug.print;

pub fn main() void {
    var com_frame = async getPageTitle("http://example.com");
    var org_frame = async getPageTitle("http://example.org");

    var com_title = com_frame;
    var org_title = org_frame;

    print(".com: {s}, .org: {s}.\\n", .{ com_title, org_title });
}

fn getPageTitle(url: []const u8) []const u8 {
    // Please PRETEND this is actually making a network request.
    _ = url;
    return "Example Title";
}
`;

test.skip("ziglings 089 async6 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 089 async6 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 089 async6 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0896", built, "");
});
