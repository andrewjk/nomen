import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// Tcp — non-blocking sockets whose waits park the calling fiber (Phase 3 of
// ASYNC.md). The tests run a real loopback echo server and client on the
// C and aarch64 backends.

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
		await build_and_check_output(input, "tcp_echo", "echo:hello\n", true);
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
		await build_and_check_output(input, "tcp_refused", "connect error 3\n", true);
	});

	test("many concurrent fiber connections echo on few workers", async () => {
		// The Phase 3 acceptance shape: N sockets in flight, handled by
		// fibers that park on the netpoller (not by N blocked threads).
		const input = `
import System

// The connection is handed to the handler as a bare fd: a class local in the
// accept loop would be auto-destroyed (closing the socket) at the end of the
// iteration, while the handler still needs it.
func echo_one = (int handle) {
	var Tcp conn = Tcp(handle)
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
		var int handle = conn.fd
		conn.fd = -1        // ownership moves to the handler
		Fiber(echo_one(handle)).start()
		i = i + 1
	}
}

func client = (int id, Channel done) {
	var Tcp c = Tcp.connect("127.0.0.1", 18100)
	if c.fd < 0 {
		Console.write_line("client \\{id} connect err \\{c.error}")
		done.send(0)
		return
	}
	c.send("ping")
	var string reply = c.recv(64)
	if reply.length == 4 {
		done.send(1)
	} else {
		Console.write_line("client \\{id} recv len \\{reply.length}")
		done.send(0)
	}
	c.close()
}

pub func main = () {
	var int n = 64
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
		await build_and_check_output(input, "tcp_scale", "echoed 64/64\n", true);
	});

	test("Tcp resolves through the precompiled system object (aarch64 split)", async () => {
		// The canonical system program now carries Stream/Tcp: the raw-asm
		// methods live in system.o, and the `aarch64_use_c` socket bodies
		// ride in the system companion object, which declares (not defines)
		// the concurrency runtime — the user companion stays the single
		// definition. A user TU linking both objects must run a full Tcp
		// exchange through that split (this is the shape that segfaulted
		// before the companion went declarations-only — see FOLLOWUP.md).
		const input = `
import System

pub func main = () {
	var Tcp client = Tcp.connect("127.0.0.1", 1)
	if client.fd < 0 {
		Console.write_line("connect error \\{client.error}")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const { load_system_struct_names, load_system_fn_names } = await import("./system_lib");
		const result = build(parsed.root, {
			arch: "aarch64",
			audit: true,
			emit_mode: "user",
			system_struct_names: load_system_struct_names(),
		});
		await check_output(`tcp_system_lib_aarch64`, result, "connect error 3\n", {
			arch: "aarch64",
			audit: true,
			system_lib: true,
			system_fn_names: load_system_fn_names(),
		});
	});
});
