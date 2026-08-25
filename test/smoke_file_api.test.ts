import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

test("File open/read/write round-trip via Results", async () => {
	const input = `
var File w = File()
match w.open("smoke.txt", "w") {
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
match r.open("smoke.txt", "r") {
	case .ok(did) {
		match r.readLine() {
			case .ok(a) {
				match r.readLine() {
					case .ok(b) {
						Console.write("\\{a}|\\{b}")
					}
					case .error(e) {
						Console.write("read failed")
					}
				}
			}
			case .error(e) {
				Console.write("read failed")
			}
		}
	}
	case .error(e) {
		Console.write("open failed")
	}
}
`;
	await build_and_check_output(input, "smoke_file_api", "hello|world");
});

test("File.open on missing path returns not_found; later ops report not_open", async () => {
	const input = `
var File f = File()
match f.open("no_such_smoke.txt", "r") {
	case .ok(did) {
		Console.write("opened?!")
	}
	case .error(e) {
		match e {
			case .not_found -> Console.write("not_found")
			case .access_denied -> Console.write("access_denied")
			case .already_exists -> Console.write("already_exists")
			case .not_open -> Console.write("not_open")
			case .other -> Console.write("other")
		}
	}
}
match f.readAll() {
	case .ok(text) {
		Console.write("read?!")
	}
	case .error(e) {
		match e {
			case .not_open -> Console.write("not_open")
			case .not_found -> Console.write("not_found")
			case .access_denied -> Console.write("access_denied")
			case .already_exists -> Console.write("already_exists")
			case .other -> Console.write("other")
		}
	}
}
`;
	await build_and_check_output(input, "smoke_file_error", "not_foundnot_open");
});

test("File static helpers via Results", async () => {
	const input = `
File.write_all("smoke_static.txt", "static io")
match File.read_all("smoke_static.txt") {
	case .ok(body) {
		Console.write(body)
	}
	case .error(e) {
		Console.write("read_all failed")
	}
}
if File.exists("smoke_static.txt") {
	match File.delete("smoke_static.txt") {
		case .ok(did) {
			if File.exists("smoke_static.txt") {
				Console.write("still here")
			} else {
				Console.write("gone")
			}
		}
		case .error(e) {
			Console.write("delete failed")
		}
	}
}
`;
	await build_and_check_output(input, "smoke_file_static", "static iogone");
});

test("Directory create/list/remove via Results", async () => {
	const input = `
File.delete("smoke_dir/a.txt")
File.delete("smoke_dir/b.txt")
Directory.remove("smoke_dir")
match Directory.create("smoke_dir") {
	case .ok(did) {
		File.write_all("smoke_dir/a.txt", "x")
		File.write_all("smoke_dir/b.txt", "y")
		match Directory.list("smoke_dir") {
			case .ok(names) {
				Console.write(names.length.to_string())
			}
			case .error(e) {
				Console.write("list failed")
			}
		}
		File.delete("smoke_dir/a.txt")
			File.delete("smoke_dir/b.txt")
			match Directory.remove("smoke_dir") {
				case .ok(did2) {
					Console.write("removed")
				}
			case .error(e) {
				match e {
					case .not_empty -> Console.write("not_empty")
					case .not_found -> Console.write("not_found")
					case .access_denied -> Console.write("access_denied")
					case .already_exists -> Console.write("already_exists")
					case .other -> Console.write("other")
				}
			}
		}
	}
	case .error(e) {
		Console.write("create failed")
	}
}
`;
	await build_and_check_output(input, "smoke_dir_api", "12removed");
});
