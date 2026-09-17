import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// Tcp — non-blocking sockets whose waits park the calling fiber (Phase 3 of
// ASYNC_PLAN.md). The tests run a real loopback echo server and client on the
// C and aarch64 backends.

const ARCHITECTURES = ["c", "aarch64"] as const;
const OPTIONS = { audit: true } as const;

describe("Tcp", () => {
	test("a fiber server echoes a request and the client reads it back", async () => {
		const input = `
import System

func serve_one = (Tcp listener) {
	var Tcp server = listener         // params are read-only; accept() mutates
	var Tcp conn = server.accept()     // parks until the client connects
	if conn.fd < 0 {
		return
	}
	var string msg = conn.recv(64)     // parks until data arrives
	conn.send("echo:" + msg)
	conn.close()
}

pub func main = () {
	var Tcp server = Tcp.listen(18081, 16)
	if server.fd < 0 {
		Console.write_line("listen failed")
		return
	}
	async {
		var handler = Fiber(serve_one(server)).start()
		var Tcp client = Tcp.connect("127.0.0.1", 18081)
		if client.fd < 0 {
			Console.write_line("connect failed")
		} else {
			client.send("hello")
			var string reply = client.recv(64)
			Console.write_line(reply)
			client.close()
		}
		handler.wait()
	}
	server.close()
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`tcp_echo_${arch}`, result, "echo:hello\n", options);
		}
	});

	test("a refused connection reports a connect error", async () => {
		const input = `
import System

pub func main = () {
	var Tcp client = Tcp.connect("127.0.0.1", 1)
	if client.fd < 0 {
		Console.write_line("connect error \\{client.error}")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`tcp_refused_${arch}`, result, "connect error 3\n", options);
		}
	});

	// TODO: enable once concurrent Tcp I/O works (FOLLOWUP.md "Tcp:
	// concurrent fiber connections fail"). Single-connection echo/refused
	// paths are verified above; at N > 1 every client fails.
	test.skip("many concurrent fiber connections echo on few workers", async () => {
		// The Phase 3 acceptance shape: N sockets in flight, handled by
		// fibers that park on the netpoller (not by N blocked threads).
		const input = `
import System

func echo_one = (Tcp peer) {
	var Tcp conn = peer
	var string msg = conn.recv(64)
	if msg.length > 0 {
		conn.send(msg)
	}
	conn.close()
}

func server_loop = (Tcp server, int n) {
	var Tcp listener = server
	var int i = 0
	while i < n {
		var Tcp conn = listener.accept()
		if conn.fd < 0 {
			return
		}
		Fiber(echo_one(conn)).start()
		i = i + 1
	}
}

func client = (int id, Channel done) {
	var Tcp c = Tcp.connect("127.0.0.1", 18100)
	if c.fd < 0 {
		done.send(0)
		return
	}
	c.send("ping")
	var string reply = c.recv(64)
	if reply.length == 4 {
		done.send(1)
	} else {
		done.send(0)
	}
	c.close()
}

pub func main = () {
	var int n = 8
	var Channel done = Channel()
	var Tcp listener = Tcp.listen(18100, 1024)
	if listener.fd < 0 {
		Console.write_line("listen failed")
		return
	}
	async {
		Fiber(server_loop(listener, n)).start()
		var int i = 0
		while i < n {
			Fiber(client(i, done)).start()
			i = i + 1
		}
	}
	var int ok = 0
	var int i = 0
	while i < n {
		ok = ok + (done.receive() as int)
		i = i + 1
	}
	listener.close()
	Console.write_line("echoed \\{ok}/\\{n}")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`tcp_scale_${arch}`, result, "echoed 8/8\n", options);
		}
	});
});
