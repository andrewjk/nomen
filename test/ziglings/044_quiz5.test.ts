import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
//    "Elephants walking
//     Along the trails
//
//     Are holding hands
//     By holding tails."
//
//     from Holding Hands
//       by Lenore M. Link
//
const std = @import("std");

const Elephant = struct {
    letter: u8,
    tail: *Elephant = undefined,
    visited: bool = false,
};

pub fn main() void {
    var elephantA = Elephant{ .letter = 'A' };
    // (Please add Elephant B here!)
    var elephantC = Elephant{ .letter = 'C' };

    // Link the elephants so that each tail "points" to the next elephant.
    // They make a circle: A->B->C->A...
    elephantA.tail = &elephantB;
    // (Please link Elephant B's tail to Elephant C here!)
    elephantC.tail = &elephantA;

    visitElephants(&elephantA);

    std.debug.print("\\n", .{});
}

// This function visits all elephants once, starting with the
// first elephant and following the tails to the next elephant.
// If we did not "mark" the elephants as visited (by setting
// visited=true), then this would loop infinitely!
fn visitElephants(first_elephant: *Elephant) void {
    var e = first_elephant;

    while (!e.visited) {
        std.debug.print("Elephant {u}. ", .{e.letter});
        e.visited = true;
        e = e.tail;
    }
}
`;

test.skip("ziglings 044 quiz5 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 044 quiz5 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 044 quiz5 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0445", built, "");
});
