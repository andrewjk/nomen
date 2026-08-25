import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise teaches interacting with the file system:
// create a directory, open a file in it, and write to the file.
//
// Nomen mirrors this with Directory.create (System/Stream/Directory.nm)
// and File (System/Stream/File.nm) which opens a path for a given mode.
// `writeChunk(data, size)` writes exactly `size` bytes, so the byte count
// reported is the size we asked to write. Fallible operations return
// `Result<..., FileError>` / `Result<..., DirectoryError>`.

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
    match f.open("output/zigling.txt", "w") {
        case .ok(did) {
            match f.writeChunk("It's zigling time!", 18) {
                case .ok(wrote) { Console.write("Successfully wrote 18 bytes.\\n") }
                case .error(e) { Console.write("write failed") }
            }
        }
        case .error(e) { Console.write("open failed") }
    }
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
    match f.open("output/zigling.txt", "w") {
        case .ok(did) {
            match f.writeChunk("It's zigling time!", 18) {
                case .ok(wrote) { Console.write("Successfully wrote 18 bytes.\\n") }
                case .error(e) { Console.write("write failed") }
            }
        }
        case .error(e) { Console.write("open failed") }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_106", "Successfully wrote 18 bytes.\n", true);
});
