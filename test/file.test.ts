import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("File write/read", () => {
	test("writeLine then readLine", async () => {
		const input = `
var File w = File()
w.open("filetest_wl.txt", "w")
w.writeLine("hello")
w.writeLine("world")
w.close()

var File r = File()
r.open("filetest_wl.txt", "r")
const string a = r.readLine()
const string b = r.readLine()
Console.write("\\{a}|\\{b}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("file_write_read_line", result, "hello|world");
	});

	test("writeAll then readAll", async () => {
		const input = `
var File w = File()
w.open("filetest_all.txt", "w")
w.writeAll("echo file io")
w.close()

var File r = File()
r.open("filetest_all.txt", "r")
const string content = r.readAll()
Console.write(content)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("file_write_read_all", result, "echo file io");
	});

	test("eof is set after readAll", async () => {
		const input = `
var File w = File()
w.open("filetest_eof.txt", "w")
w.writeAll("x")
w.close()

var File r = File()
r.open("filetest_eof.txt", "r")
const string c = r.readAll()
if r.eof {
	Console.write("done")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("file_eof", result, "done");
	});

	test("readChunk and writeChunk", async () => {
		const input = `
var File w = File()
w.open("filetest_chunk.txt", "w")
w.writeChunk("abcdef", 6)
w.close()

var File r = File()
r.open("filetest_chunk.txt", "r")
const string part = r.readChunk(3)
Console.write(part)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("file_chunk", result, "abc");
	});
});
