import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise teaches interacting with the file system:
// create a directory, open a file in it, and write to the file.
//
// Nomen mirrors this with Directory.create (System/Stream/Directory.nm)
// and File (System/Stream/File.nm) which opens a path for a given mode.
// `writeChunk(data, size)` writes exactly `size` bytes, so the byte count
// reported is the size we asked to write.

test("ziglings 106 files -- errors", () => {
	// writeChunk needs both the data and a size; omitting the size is an error.
	const input = `
import System

pub func main = () {
    Directory.create("output")
    var File f = File()
    f.open("output/zigling.txt", "w")
    f.writeChunk("It's zigling time!")
    Console.write("Successfully wrote 18 bytes.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 106 files -- fixed", () => {
	const input = `
import System

pub func main = () {
    Directory.create("output")
    var File f = File()
    f.open("output/zigling.txt", "w")
    f.writeChunk("It's zigling time!", 18)
    Console.write("Successfully wrote 18 bytes.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 106 files -- build", async () => {
	const input = `
import System

pub func main = () {
    Directory.create("output")
    var File f = File()
    f.open("output/zigling.txt", "w")
    f.writeChunk("It's zigling time!", 18)
    Console.write("Successfully wrote 18 bytes.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("106", built, "Successfully wrote 18 bytes.\n");
});
