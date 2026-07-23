import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `//
// Remember how a function with 'suspend' is async and calling an
// async function without the 'async' keyword makes the CALLING
// function async?
//
//     fn fooThatMightSuspend(maybe: bool) void {
//         if (maybe) suspend {}
//     }
//
//     fn bar() void {
//         fooThatMightSuspend(true); // Now bar() is async!
//     }
//
// But if you KNOW the function won't suspend, you can make a
// promise to the compiler with the 'nosuspend' keyword:
//
//     fn bar() void {
//         nosuspend fooThatMightSuspend(false);
//     }
//
// If the function does suspend and YOUR PROMISE TO THE COMPILER
// IS BROKEN, the program will panic at runtime, which is
// probably better than you deserve, you oathbreaker! >:-(
//
const print = @import("std").debug.print;

pub fn main() void {

    // The main() function can not be async. But we know
    // getBeef() will not suspend with this particular
    // invocation. Please make this okay:
    var my_beef = getBeef(0);

    print("beef? {X}!\\n", .{my_beef});
}

fn getBeef(input: u32) u32 {
    if (input == 0xDEAD) {
        suspend {}
    }

    return 0xBEEF;
}
//
// Going Deeper Into...
//                     ...uNdeFiNEd beHAVi0r!
//
// We haven't discussed it yet, but runtime "safety" features
// require some extra instructions in your compiled program.
// Most of the time, you're going to want to keep these in.
//
// But in some programs, when data integrity is less important
// than raw speed (some games, for example), you can compile
// without these safety features.
//
// Instead of a safe panic when something goes wrong, your
// program will now exhibit Undefined Behavior (UB), which simply
// means that the Zig language does not (cannot) define what will
// happen. The best case is that it will crash, but in the worst
// case, it will continue to run with the wrong results and
// corrupt your data or expose you to security risks.
//
// This program is a great way to explore UB. Once you get it
// working, try calling the getBeef() function with the value
// 0xDEAD so that it will invoke the 'suspend' keyword:
//
//     getBeef(0xDEAD)
//
// Now when you run the program, it will panic and give you a
// nice stack trace to help debug the problem.
//
//     zig run exercises/090_async7.zig
//     thread 328 panic: async function called...
//     ...
//
// But see what happens when you turn off safety checks by using
// ReleaseFast mode:
//
//     zig run -O ReleaseFast exercises/090_async7.zig
//     beef? 0!
//
// This is the wrong result. On your computer, you may get a
// different answer or it might crash! What exactly will happen
// is UNDEFINED. Your computer is now like a wild animal,
// reacting to bits and bytes of raw memory with the base
// instincts of the CPU. It is both terrifying and exhilarating.
//
`;

test.skip("ziglings 090 async7 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 090 async7 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 090 async7 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0907", built, "");
});
