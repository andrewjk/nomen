import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

// `Thread(fn(args)).detach()` — the daemon form (ASYNC.md, "Daemon tasks";
// SPEC.md, "Daemon tasks"): a process-lifetime service on its own dedicated
// pthread. Neither shape here could be expressed before: inside a nursery
// the never-ending task blocks the brace join, and a bare `.start()` daemon
// kept its pool worker alive so the atexit `pthread_join` hung forever.
// With `.detach()`, process exit kills the daemon by design — so every test
// below returns from main while the daemon is still running. Daemon tests
// run with audit off: a daemon killed mid-flight leaks its trampoline args
// by construction. Each runtime test loops over the C and aarch64 backends.

describe("daemon tasks (Thread.detach)", () => {
	test("a daemon does not block main or process exit", async () => {
		const input = `
import System

func flusher = (Channel ch) {
	ch.send(1)                         // report startup
	while true { Time.sleep_ms(1000) } // process-lifetime service loop
}

var Channel sink = Channel()         // app-lifetime: the daemon shares it

pub func main = () {
	Thread(flusher(sink)).detach()
	var uint64 v = sink.receive()      // the daemon is up
	if v == 1 {
		Console.write_line("daemon alive")
	}
	// returning does not wait for the daemon
}
`;
		await build_and_check_output(input, "daemon_detached", "daemon alive\n", true, {
			audit: false,
		});
	});

	test("a tight-loop daemon that never parks still does not block exit", async () => {
		// The shape that used to hang unconditionally: a never-ending pool
		// task kept its worker inside the task body, so the atexit
		// pthread_join never returned. A detached daemon is not a worker and
		// is not joined — exit kills it mid-spin.
		const input = `
import System

func spinner = (Channel ch) {
	ch.send(1)
	var uint64 spins = 0
	while true {
		spins += 1
	}
}

var Channel sink = Channel()         // app-lifetime: the daemon shares it

pub func main = () {
	Thread(spinner(sink)).detach()
	var uint64 v = sink.receive()
	if v == 1 {
		Console.write_line("spinner up")
	}
}
`;
		await build_and_check_output(input, "daemon_spin", "spinner up\n", true, { audit: false });
	});

	test("detach inside a nursery is not tracked by the join", async () => {
		// The escape from "the never-ending task blocks the brace join": a
		// detached daemon inside async { } is invisible to the nursery, the
		// block exits, and the program continues while the daemon runs.
		const input = `
import System

func heartbeat = (Channel ch) {
	ch.send(1)
	while true { Time.sleep_ms(1000) }
}

var Channel sink = Channel()         // app-lifetime: the daemon shares it

func session = (out uint64) {
	async {
		Thread(heartbeat(sink)).detach()
	}
	return 7
}

pub func main = () {
	var f = Fiber(session()).start()
	var uint64 r = f.result()
	if r == 7 {
		Console.write_line("session done, daemon outlives it")
	}
}
`;
		await build_and_check_output(
			input,
			"daemon_nursery_escape",
			"session done, daemon outlives it\n",
			true,
			{ audit: false },
		);
	});

	test("a bare owning argument to a daemon is rejected outside a nursery (R1)", () => {
		// Thread.start is a library method and the construction resolves
		// through Thread's declared #spawn member, so the source imports
		// System explicitly (no parse_raw auto-import here: the input is a
		// full program with its own main).
		const input = `
import System
pub owning struct Unsafe {
	var uint64 code = 0
}

func leak = (Unsafe u) {
}

pub func main = () {
	var Unsafe u = Unsafe()
	Thread(leak(u)).detach()
}
`;
		// This input is a full program (its own main), so it parses directly
		// with the System library — parse_raw would wrap it in a second main.
		const parsed = parse(input, get_library("core"));
		const messages = parsed.errors.map((e) => e.message);
		// R1: a daemon has no join to bound a borrow — the bare owning arg
		// is rejected with the two sound spellings named.
		expect(messages.some((m) => m.includes("owns heap memory"))).toBe(true);
	});
});
