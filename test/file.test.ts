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

describe("File static helpers", () => {
	test("File.write_all and File.read_all round-trip", async () => {
		const input = `
File.write_all("filetest_static.txt", "static io")
const string body = File.read_all("filetest_static.txt")
Console.write(body)
`;
		await build_and_check_output(input, "file_static_read_write", "static io");
	});

	test("File.exists is true for present and false for absent", async () => {
		const input = `
File.write_all("filetest_exists.txt", "x")
if File.exists("filetest_exists.txt") {
	if File.exists("filetest_no_such_xyz.txt") {
		Console.write("both")
	} else {
		Console.write("one")
	}
} else {
	Console.write("none")
}
`;
		await build_and_check_output(input, "file_exists", "one");
	});

	test("File.delete removes the file", async () => {
		const input = `
File.write_all("filetest_delete.txt", "x")
File.delete("filetest_delete.txt")
if File.exists("filetest_delete.txt") {
	Console.write("still here")
} else {
	Console.write("gone")
}
`;
		await build_and_check_output(input, "file_delete", "gone");
	});

	test("File.read_all on missing file yields empty string", async () => {
		const input = `
const string body = File.read_all("filetest_no_such_xyz.txt")
if body.length == 0 {
	Console.write("empty")
}
`;
		await build_and_check_output(input, "file_read_all_missing", "empty");
	});
});
