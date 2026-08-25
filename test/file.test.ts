import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("File write/read", () => {
	test("writeLine then readLine", async () => {
		const input = `
var File w = File()
match w.open("filetest_wl.txt", "w") {
	case .ok(did) {
		w.writeLine("hello")
		w.writeLine("world")
		w.close()
	}
	case .error(e) {
		Console.write("open failed")
	}
}

var File r = File()
match r.open("filetest_wl.txt", "r") {
	case .ok(did) {
		match r.readLine() {
			case .ok(a) {
				match r.readLine() {
					case .ok(b) {
						Console.write("\\{a}|\\{b}")
					}
					case .error(e2) {
						Console.write("read failed")
					}
				}
			}
			case .error(e1) {
				Console.write("read failed")
			}
		}
	}
	case .error(e0) {
		Console.write("open failed")
	}
}
`;
		await build_and_check_output(input, "file_write_read_line", "hello|world");
	});

	test("writeAll then readAll", async () => {
		const input = `
var File w = File()
match w.open("filetest_all.txt", "w") {
	case .ok(did) {
		w.writeAll("nomen file io")
		w.close()
	}
	case .error(e) {
		Console.write("open failed")
	}
}

var File r = File()
match r.open("filetest_all.txt", "r") {
	case .ok(did) {
		match r.readAll() {
			case .ok(content) {
				Console.write(content)
			}
			case .error(e2) {
				Console.write("read failed")
			}
		}
	}
	case .error(e1) {
		Console.write("open failed")
	}
}
`;
		await build_and_check_output(input, "file_write_read_all", "nomen file io");
	});

	test("eof is set after readAll", async () => {
		const input = `
var File w = File()
match w.open("filetest_eof.txt", "w") {
	case .ok(did) {
		w.writeAll("x")
		w.close()
	}
	case .error(e) {
		Console.write("open failed")
	}
}

var File r = File()
match r.open("filetest_eof.txt", "r") {
	case .ok(did) {
		match r.readAll() {
			case .ok(c) {
				if r.eof {
					Console.write("done")
				}
			}
			case .error(e2) {
				Console.write("read failed")
			}
		}
	}
	case .error(e1) {
		Console.write("open failed")
	}
}
`;
		await build_and_check_output(input, "file_eof", "done");
	});

	test("readChunk and writeChunk", async () => {
		const input = `
var File w = File()
match w.open("filetest_chunk.txt", "w") {
	case .ok(did) {
		w.writeChunk("abcdef", 6)
		w.close()
	}
	case .error(e) {
		Console.write("open failed")
	}
}

var File r = File()
match r.open("filetest_chunk.txt", "r") {
	case .ok(did) {
		match r.readChunk(3) {
			case .ok(part) {
				Console.write(part)
			}
			case .error(e2) {
				Console.write("read failed")
			}
		}
	}
	case .error(e1) {
		Console.write("open failed")
	}
}
`;
		await build_and_check_output(input, "file_chunk", "abc");
	});
});

describe("File static helpers", () => {
	test("File.write_all and File.read_all round-trip", async () => {
		const input = `
match File.write_all("filetest_static.txt", "static io") {
	case .ok(did) {
		match File.read_all("filetest_static.txt") {
			case .ok(body) {
				Console.write(body)
			}
			case .error(e2) {
				Console.write("read_all failed")
			}
		}
	}
	case .error(e) {
		Console.write("write_all failed")
	}
}
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
match File.delete("filetest_delete.txt") {
	case .ok(did) {
		if File.exists("filetest_delete.txt") {
			Console.write("still here")
		} else {
			Console.write("gone")
		}
	}
	case .error(e) {
		Console.write("delete failed")
	}
}
`;
		await build_and_check_output(input, "file_delete", "gone");
	});

	test("File.open on a missing path reports not_found and later reads report not_open", async () => {
		const input = `
var File f = File()
match f.open("filetest_no_such_xyz.txt", "r") {
	case .ok(did) {
		Console.write("opened?!")
	}
	case .error(e) {
		match e {
			case .not_found -> Console.write("not_found ")
			else -> Console.write("other ")
		}
	}
}
match f.readAll() {
	case .ok(text) {
		Console.write("read?!")
	}
	case .error(e2) {
		match e2 {
			case .not_open -> Console.write("not_open")
			else -> Console.write("other")
		}
	}
}
`;
		await build_and_check_output(input, "file_open_missing", "not_found not_open");
	});

	test("File.read_all on missing file yields an error result", async () => {
		const input = `
match File.read_all("filetest_no_such_xyz.txt") {
	case .ok(body) {
		Console.write("content?!")
	}
	case .error(e) {
		match e {
			case .not_found -> Console.write("empty")
			else -> Console.write("other")
		}
	}
}
`;
		await build_and_check_output(input, "file_read_all_missing", "empty");
	});
});
