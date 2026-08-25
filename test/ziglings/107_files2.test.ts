import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise reads back the file written in 106_files and
// reports the number of bytes read. string.length (strlen) gives us that
// count. To keep the test self-contained, it creates the directory, writes
// the file, then reads it back. File operations return
// `Result<..., FileError>`, so each fallible step is matched.

test("ziglings 107 files2 -- errors", () => {
	// open requires a mode argument; omitting it is an error.
	const input = `
import System

pub func main = () {
    Directory.create("output")
    var File w = File()
    match w.open("output/zigling.txt", "w") {
        case .ok(did) {
            w.writeAll("It's zigling time!")
            w.close()
        }
        case .error(e) { Console.write("open failed") }
    }

    var File r = File()
    r.open("output/zigling.txt")
    const string content = r.readAll()
    Console.write("Successfully Read \\{content.length} bytes: \\{content}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 107 files2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    Directory.create("output")
    var File w = File()
    match w.open("output/zigling.txt", "w") {
        case .ok(did) {
            w.writeAll("It's zigling time!")
            w.close()
        }
        case .error(e) { Console.write("open failed") }
    }

    var File r = File()
    match r.open("output/zigling.txt", "r") {
        case .ok(did) {
            match r.readAll() {
                case .ok(content) {
                    Console.write("Successfully Read \\{content.length} bytes: \\{content}\\n")
                }
                case .error(e2) { Console.write("read failed") }
            }
        }
        case .error(e1) { Console.write("open failed") }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 107 files2 -- build", async () => {
	const input = `
import System

pub func main = () {
    Directory.create("output")
    var File w = File()
    match w.open("output/zigling.txt", "w") {
        case .ok(did) {
            w.writeAll("It's zigling time!")
            w.close()
        }
        case .error(e) { Console.write("open failed") }
    }

    var File r = File()
    match r.open("output/zigling.txt", "r") {
        case .ok(did) {
            match r.readAll() {
                case .ok(content) {
                    Console.write("Successfully Read \\{content.length} bytes: \\{content}\\n")
                }
                case .error(e2) { Console.write("read failed") }
            }
        }
        case .error(e1) { Console.write("open failed") }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(
		input,
		"ziglings_107",
		"Successfully Read 18 bytes: It's zigling time!\n",
		true,
	);
});
