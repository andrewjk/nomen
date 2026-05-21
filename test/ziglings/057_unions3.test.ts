import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// With tagged unions, it gets EVEN BETTER! If you don't have a
// need for a separate enum, you can define an inferred enum with
// your union all in one place. Just use the 'enum' keyword in
// place of the tag type:
//
//     const Foo = union(enum) {
//         small: u8,
//         medium: u32,
//         large: u64,
//     };
//
// Let's convert Insect. Doctor Zoraptera has already deleted the
// explicit InsectStat enum for you!
//
const std = @import("std");

const Insect = union(InsectStat) {
    flowers_visited: u16,
    still_alive: bool,
};

pub fn main() void {
    const ant = Insect{ .still_alive = true };
    const bee = Insect{ .flowers_visited = 17 };

    std.debug.print("Insect report! ", .{});

    printInsect(ant);
    printInsect(bee);

    std.debug.print("\\n", .{});
}

fn printInsect(insect: Insect) void {
    switch (insect) {
        .still_alive => |a| std.debug.print("Ant alive is: {}. ", .{a}),
        .flowers_visited => |f| std.debug.print("Bee visited {} flowers. ", .{f}),
    }
}

// Inferred enums are neat, representing the tip of the iceberg
// in the relationship between enums and unions. You can actually
// coerce a union TO an enum (which gives you the active field
// from the union as an enum). What's even wilder is that you can
// coerce an enum to a union! But don't get too excited, that
// only works when the union type is one of those weird zero-bit
// types like void!
//
// Tagged unions, as with most ideas in computer science, have a
// long history going back to the 1960s. However, they're only
// recently becoming mainstream, particularly in system-level
// programming languages. You might have also seen them called
// "variants", "sum types", or even "enums"!
`;

test.skip("ziglings 057 unions3 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 057 unions3 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 057 unions3 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0573", built, "");
});
