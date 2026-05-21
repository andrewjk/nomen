import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to echo
const zig_source = `//
// Prerequisite :
//    - exercise/106_files.zig, or
//    - create a file {project_root}/output/zigling.txt
//      with content \`It's zigling time!\`(18 byte total)
//
// Now there's no point in writing to a file if we don't read from it, am I right?
// Let's write a program to read the content of the file that we just created.
//
// I am assuming that you've created the appropriate files for this to work.
//
// Alright, bud, lean in close. Here's the game plan.
//    - First, we open the {project_root}/output/ directory
//    - Secondly, we open file \`zigling.txt\` in that directory
//    - Then, we initalize an array of characters with all letter 'A', and print it
//    - After that, we read the content of the file into the array
//    - Finally, we print out the content we just read

const std = @import("std");

pub fn main() !void {
    // Get the current working directory
    const cwd = std.fs.cwd();

    // try to open ./output assuming you did your 106_files exercise
    var output_dir = try cwd.openDir("output", .{});
    defer output_dir.close();

    // try to open the file
    const file = try output_dir.openFile("zigling.txt", .{});
    defer file.close();

    // initalize an array of u8 with all letter 'A'
    // we need to pick the size of the array, 64 seems like a good number
    // fix the initalization below
    var content = ['A']*64;
    // this should print out : \`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\`
    std.debug.print("{s}\\n", .{content});

    // okay, seems like a threat of violence is not the answer in this case
    // can you go here to find a way to read the content?
    // https://ziglang.org/documentation/master/std/#std.fs.File
    // hint: you might find two answers that are both vaild in this case
    const bytes_read = zig_read_the_file_or_i_will_fight_you(&content);

    // Woah, too screamy. I know you're excited for zigling time but tone it down a bit.
    // Can you print only what we read from the file?
    std.debug.print("Successfully Read {d} bytes: {s}\\n", .{
        bytes_read,
        content, // change this line only
    });
}
`;

test.skip("ziglings 107 files2 -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 107 files2 -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 107 files2 -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("1072", built, "");
});
