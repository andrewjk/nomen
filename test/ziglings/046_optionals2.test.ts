import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Now that we have optional types, we can apply them to structs.
// The last time we checked in with our elephants, we had to link
// all three of them together in a "circle" so that the last tail
// linked to the first elephant. This is because we had NO CONCEPT
// of a tail that didn't point to another elephant!
//
// We also introduce the handy \`.?\` shortcut:
//
//     const foo = bar.?;
//
// is the same as
//
//     const foo = bar orelse unreachable;
//
// Check out where we use this shortcut below to change control flow
// based on if an optional value exists.
//
// Now let's make those elephant tails optional!
//
const std = @import("std");

const Elephant = struct {
    letter: u8,
    tail: *Elephant = null, // Hmm... tail needs something...
    visited: bool = false,
};

pub fn main() void {
    var elephantA = Elephant{ .letter = 'A' };
    var elephantB = Elephant{ .letter = 'B' };
    var elephantC = Elephant{ .letter = 'C' };

    // Link the elephants so that each tail "points" to the next.
    linkElephants(&elephantA, &elephantB);
    linkElephants(&elephantB, &elephantC);

    // \`linkElephants\` will stop the program if you try and link an
    // elephant that doesn't exist! Uncomment and see what happens.
    // const missingElephant: ?*Elephant = null;
    // linkElephants(&elephantC, missingElephant);

    visitElephants(&elephantA);

    std.debug.print("\\n", .{});
}

// If e1 and e2 are valid pointers to elephants,
// this function links the elephants so that e1's tail "points" to e2.
fn linkElephants(e1: ?*Elephant, e2: ?*Elephant) void {
    e1.?.*.tail = e2.?;
}

// This function visits all elephants once, starting with the
// first elephant and following the tails to the next elephant.
fn visitElephants(first_elephant: *Elephant) void {
    var e = first_elephant;

    while (!e.visited) {
        std.debug.print("Elephant {u}. ", .{e.letter});
        e.visited = true;

        // We should stop once we encounter a tail that
        // does NOT point to another element. What can
        // we put here to make that happen?

        // HINT: We want something similar to what \`.?\` does,
        // but instead of ending the program, we want to exit the loop...
        e = e.tail ???
    }
}
`;

test.skip("ziglings 046 optionals2 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 046 optionals2 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 046 optionals2 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0462", built, "");
});
