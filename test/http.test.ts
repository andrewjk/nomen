import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

// Http (System/Stream/Http.nm) reports failures through
// `Result<..., HttpError>` like File/Directory. The run tests use a
// connect-refused port on 127.0.0.1 so they are deterministic and never
// touch the network: get/post fail with `HttpError.connect` and `status`
// stays 0. The loopback tests run a real minimal HTTP server over Tcp and
// exercise the success path (request build, status parse, body split) on
// both backends — Http is ported onto Tcp (ASYNC_PLAN.md Phase 3), so the
// client parks via the netpoller inside a fiber instead of blocking.

describe("Http Result API", () => {
	test("get/post Result shape parses and checks", () => {
		const input = `
var Http h = Http()
match h.get("http://127.0.0.1:1/") {
	case .ok(body) {
		Console.write(body)
	}
	case .error(e) {
		match e {
			case .dns -> Console.write("dns ")
			case .socket -> Console.write("socket ")
			case .connect -> Console.write("connect ")
			else -> Console.write("other ")
		}
	}
}
match h.post("http://127.0.0.1:1/", "hello=world") {
	case .ok(body) {
		Console.write(body)
	}
	case .error(e) {
		Console.write("post failed")
	}
}
Console.write("\\{h.status}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("get/post on a refused port yield HttpError.connect and status 0", async () => {
		const input = `
var Http h = Http()
match h.get("http://127.0.0.1:1/") {
	case .ok(body) {
		Console.write("body?! ")
	}
	case .error(e) {
		match e {
			case .connect -> Console.write("connect ")
			else -> Console.write("other ")
		}
	}
}
match h.post("http://127.0.0.1:1/", "hello=world") {
	case .ok(body) {
		Console.write("body?!")
	}
	case .error(e) {
		match e {
			case .connect -> Console.write("connect")
			else -> Console.write("other")
		}
	}
}
Console.write(" ")
Console.write("\\{h.status}")
`;
		await build_and_check_output(input, "http_connect_refused", "connect connect 0");
	});

	test("get over loopback Tcp returns the body and status", async () => {
		const input = `
import System

func serve_one = (Tcp listener) {
	var Tcp server = listener         // params are read-only; accept() mutates
	var Tcp conn = server.accept()    // parks until the client connects
	if conn.fd < 0 {
		return
	}
	var string req = conn.recv(512)
	if req.length > 0 {
		conn.send("HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\n\\r\\nhello")
	}
	conn.close()
}

pub func main = () {
	var Tcp listener = Tcp.listen(18091, 16)
	if listener.fd < 0 {
		Console.write_line("listen failed")
		return
	}
	async {
		var handler = Fiber(serve_one(listener)).start()
		var Http h = Http()
		var Result<string, HttpError> r = h.get("http://127.0.0.1:18091/hello")
		match r {
			case .ok(body) {
				Console.write_line(body)
			}
			case .error(e) {
				Console.write_line("error")
			}
		}
		Console.write_line("\\{h.status}")
		handler.wait()
	}
	listener.close()
}
`;
		for (const arch of ["c", "aarch64"] as const) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`http_get_loopback_${arch}`, result, "hello\n200\n", options);
		}
	});

	test("post over loopback Tcp delivers the body", async () => {
		const input = `
import System

func serve_post = (Tcp listener) {
	var Tcp server = listener
	var Tcp conn = server.accept()
	if conn.fd < 0 {
		return
	}
	// Accumulate until the posted body shows up (the body is the last thing
	// the client sends, so its arrival means the request is complete).
	var string req = ""
	var bool done = false
	while !done {
		var string chunk = conn.recv(512)
		if chunk.length == 0 {
			done = true
		} else {
			req = req + chunk
			if req.contains("hello=world") {
				done = true
			}
		}
	}
	var string reply = "nope"
	if req.contains("hello=world") {
		reply = "got-post"
	}
	conn.send("HTTP/1.1 201 Created\\r\\nContent-Length: \\{reply.length}\\r\\n\\r\\n" + reply)
	conn.close()
}

pub func main = () {
	var Tcp listener = Tcp.listen(18092, 16)
	if listener.fd < 0 {
		Console.write_line("listen failed")
		return
	}
	async {
		var handler = Fiber(serve_post(listener)).start()
		var Http h = Http()
		var Result<string, HttpError> r = h.post("http://127.0.0.1:18092/submit", "hello=world")
		match r {
			case .ok(body) {
				Console.write_line(body)
			}
			case .error(e) {
				Console.write_line("error")
			}
		}
		Console.write_line("\\{h.status}")
		handler.wait()
	}
	listener.close()
}
`;
		for (const arch of ["c", "aarch64"] as const) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`http_post_loopback_${arch}`, result, "got-post\n201\n", options);
		}
	});
});
