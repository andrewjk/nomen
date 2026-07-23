import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

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
		await build_and_check_output(input, "file_write_read_line", "hello|world");
	});

	test("writeAll then readAll", async () => {
		const input = `
var File w = File()
w.open("filetest_all.txt", "w")
w.writeAll("nomen file io")
w.close()

var File r = File()
r.open("filetest_all.txt", "r")
const string content = r.readAll()
Console.write(content)
`;
		await build_and_check_output(input, "file_write_read_all", "nomen file io");
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
		await build_and_check_output(input, "file_eof", "done");
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
		await build_and_check_output(input, "file_chunk", "abc");
	});
});
