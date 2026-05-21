import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Until now, we've only been printing our output in the console,
// which is good enough for fighting aliens and hermit bookkeeping.
//
// However, many other tasks require some interaction with the file system,
// which is the underlying structure for organizing files on your computer.
//
// The file system provides a hierarchical structure for storing files
// by organizing them into directories, which hold files and other directories,
// thus creating a tree structure that can be navigated.
//
// Fortunately, the Zig standard library provides a simple API for interacting
// with the file system, see the detail documentation here:
//
// https://ziglang.org/documentation/master/std/#std.fs
//
// In this exercise, we'll try to:
//   - create a new directory,
//   - open a file in the directory,
//   - write to the file.
//
// import std as always
const std = @import("std");

pub fn main() !void {
    // first we get the current working directory
    const cwd: std.fs.Dir = std.fs.cwd();

    // then we'll try to make a new directory /output/
    // to store our output files.
    cwd.makeDir("output") catch |e| switch (e) {
        // there is a chance you might want to run this
        // program more than once and the path might already
        // have been created, so we'll have to handle this error
        // by doing nothing
        //
        // we want to catch error.PathAlreadyExists and do nothing
        ??? => {},
        // if there's any other unexpected error we just propagate it through
        else => return e,
    };

    // then we'll try to open our freshly created directory
    // wait a minute...
    // opening a directory might fail!
    // what should we do here?
    var output_dir: std.fs.Dir = cwd.openDir("output", .{});
    defer output_dir.close();

    // we try to open the file \`zigling.txt\`,
    // and propagate any error up
    const file: std.fs.File = try output_dir.createFile("zigling.txt", .{});
    // it is a good habit to close a file after you are done with it
    // so that other programs can read it and prevent data corruption
    // but here we are not yet done writing to the file
    // if only there were a keyword in Zig that
    // allowed you to "defer" code execution to the end of the scope...
    file.close();

    // you are not allowed to move these two lines above the file closing line!
    const byte_written = try file.write("It's zigling time!");
    std.debug.print("Successfully wrote {d} bytes.\\n", .{byte_written});
}
// to check if you actually write to the file, you can either,
// 1. open the file in your text editor, or
// 2. print the content of the file in the console with the following command
//    >> cat ./output/zigling.txt
//
//
// More on Creating files
//
// notice in:
// ... try output_dir.createFile("zigling.txt", .{});
//                                              ^^^
//                 we passed this anonymous struct to the function call
//
// this is the struct \`CreateFlag\` with default fields
// {
//      read: bool = false,
//      truncate: bool = true,
//      exclusive: bool = false,
//      lock: Lock = .none,
//      lock_nonblocking: bool = false,
//      mode: Mode = default_mode
// }
//
// Question:
//   - what should you do if you want to also read the file after opening it?
//   - go to the documentation of the struct \`std.fs.Dir\` here:
//     https://ziglang.org/documentation/master/std/#std.fs.Dir
//       - can you find a function for opening a file? how about deleting a file?
//       - what kind of options can you use with those functions?
`;

test.skip("ziglings 106 files -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 106 files -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 106 files -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("106", built, "");
});
