import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Struct types are always "anonymous" until we give them a name:
//
//     struct {};
//
// So far, we've been giving struct types a name like so:
//
//     const Foo = struct {};
//
// * The value of @typeName(Foo) is "<filename>.Foo".
//
// A struct is also given a name when you return it from a
// function:
//
//     fn Bar() type {
//         return struct {};
//     }
//
//     const MyBar = Bar();  // store the struct type
//     const bar = Bar() {}; // create instance of the struct
//
// * The value of @typeName(Bar()) is "Bar()".
// * The value of @typeName(MyBar) is "Bar()".
// * The value of @typeName(@TypeOf(bar)) is "Bar()".
//
// You can also have completely anonymous structs. The value
// of @typeName(struct {}) is "struct:<position in source>".
//
const print = @import("std").debug.print;

// This function creates a generic data structure by returning an
// anonymous struct type (which will no longer be anonymous AFTER
// it's returned from the function).
fn Circle(comptime T: type) type {
    return struct {
        center_x: T,
        center_y: T,
        radius: T,
    };
}

pub fn main() void {
    //
    // See if you can complete these two variable initialization
    // expressions to create instances of circle struct types
    // which can hold these values:
    //
    // * circle1 should hold i32 integers
    // * circle2 should hold f32 floats
    //
    const circle1 = ??? {
        .center_x = 25,
        .center_y = 70,
        .radius = 15,
    };

    const circle2 = ??? {
        .center_x = 25.234,
        .center_y = 70.999,
        .radius = 15.714,
    };

    print("[{s}: {},{},{}] ", .{
        stripFname(@typeName(@TypeOf(circle1))),
        circle1.center_x,
        circle1.center_y,
        circle1.radius,
    });

    print("[{s}: {d:.1},{d:.1},{d:.1}]\\n", .{
        stripFname(@typeName(@TypeOf(circle2))),
        circle2.center_x,
        circle2.center_y,
        circle2.radius,
    });
}

// Perhaps you remember the "narcissistic fix" for the type name
// in Ex. 065? We're going to do the same thing here: use a hard-
// coded slice to return the type name. That's just so our output
// looks prettier. Indulge your vanity. Programmers are beautiful.
fn stripFname(mytype: []const u8) []const u8 {
    return mytype[22..];
}
// The above would be an instant red flag in a "real" program.
`;

test.skip("ziglings 080 anonymous structs -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 080 anonymous structs -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 080 anonymous structs -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("080", built, "");
});
