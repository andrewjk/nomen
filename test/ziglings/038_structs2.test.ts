import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Grouping values in structs is not merely convenient. It also allows
// us to treat the values as a single item when storing them, passing
// them to functions, etc.
//
// This exercise demonstrates how we can store structs in an array and
// how doing so lets us print them using a loop.
//
const std = @import("std");

const Role = enum {
    wizard,
    thief,
    bard,
    warrior,
};

const Character = struct {
    role: Role,
    gold: u32,
    health: u8,
    experience: u32,
};

pub fn main() void {
    var chars: [2]Character = undefined;

    // Glorp the Wise
    chars[0] = Character{
        .role = Role.wizard,
        .gold = 20,
        .health = 100,
        .experience = 10,
    };

    // Please add "Zump the Loud" with the following properties:
    //
    //     role       bard
    //     gold       10
    //     health     100
    //     experience 20
    //
    // Feel free to run this program without adding Zump. What does
    // it do and why?

    // Printing all RPG characters in a loop:
    for (chars, 0..) |c, num| {
        std.debug.print("Character {} - G:{} H:{} XP:{}\\n", .{
            num + 1, c.gold, c.health, c.experience,
        });
    }
}

// If you tried running the program without adding Zump as mentioned
// above, you get what appear to be "garbage" values. In debug mode
// (which is the default), Zig writes the repeating pattern "10101010"
// in binary (or 0xAA in hex) to all undefined locations to make them
// easier to spot when debugging.
`;

test.skip("ziglings 038 structs2 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 038 structs2 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 038 structs2 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0382", built, "");
});
