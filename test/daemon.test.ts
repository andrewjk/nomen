import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// `Thread(fn(args)).detach()` — the daemon form (ASYNC.md, "Daemon tasks";
// SPEC.md, "Daemon tasks"): a process-lifetime service on its own dedicated
// pthread. Neither shape here could be expressed before: inside a nursery
// the never-ending task blocks the brace join, and a bare `.start()` daemon
// kept its pool worker alive so the atexit `pthread_join` hung forever.
// With `.detach()`, process exit kills the daemon by design — so every test
// below returns from main while the daemon is still running. Daemon tests
// run with audit off: a daemon killed mid-flight leaks its trampoline args
// by construction. Each runtime test loops over the C and aarch64 backends.

const ARCHITECTURES = ["c", "aarch64"] as const;

describe("daemon tasks (Thread.detach)", () => {
	test("a daemon does not block main or process exit", async () => {
		const input = `
import System

func flusher = (Channel sink) {
	sink.send(1)                       // report startup
	while true { Time.sleep_ms(1000) } // process-lifetime service loop
}

pub func main = () {
	var Channel sink = Channel()
	Thread(flusher(sink)).detach()
	var uint64 v = sink.receive()      // the daemon is up
	if v == 1 {
		Console.write_line("daemon alive")
	}
	// returning does not wait for the daemon
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: false };
			const result = build(parsed.root, options);
			await check_output(`daemon_detached_${arch}`, result, "daemon alive\n", options);
		}
	});

	test("a tight-loop daemon that never parks still does not block exit", async () => {
		// The shape that used to hang unconditionally: a never-ending pool
		// task kept its worker inside the task body, so the atexit
		// pthread_join never returned. A detached daemon is not a worker and
		// is not joined — exit kills it mid-spin.
		const input = `
import System

func spinner = (Channel sink) {
	sink.send(1)
	var uint64 spins = 0
	while true {
		spins += 1
	}
}

pub func main = () {
	var Channel sink = Channel()
	Thread(spinner(sink)).detach()
	var uint64 v = sink.receive()
	if v == 1 {
		Console.write_line("spinner up")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: false };
			const result = build(parsed.root, options);
			await check_output(`daemon_spin_${arch}`, result, "spinner up\n", options);
		}
	});

	test("detach inside a nursery is not tracked by the join", async () => {
		// The escape from "the never-ending task blocks the brace join": a
		// detached daemon inside async { } is invisible to the nursery, the
		// block exits, and the program continues while the daemon runs.
		const input = `
import System

func heartbeat = (Channel sink) {
	sink.send(1)
	while true { Time.sleep_ms(1000) }
}

func session = (Channel sink, out uint64) {
	async {
		Thread(heartbeat(sink)).detach()
	}
	return 7
}

pub func main = () {
	var Channel sink = Channel()
	var f = Fiber(session(sink)).start()
	var uint64 r = f.result()
	if r == 7 {
		Console.write_line("session done, daemon outlives it")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: false };
			const result = build(parsed.root, options);
			await check_output(
				`daemon_nursery_escape_${arch}`,
				result,
				"session done, daemon outlives it\n",
				options,
			);
		}
	});

	test("detach arguments must be Sendable", () => {
		const input = `
pub class Unsafe {
	var uint64 code = 0
}

func leak = (Unsafe u) {
}

pub func main = () {
	var Unsafe u = Unsafe()
	Thread(leak(u)).detach()
}
`;
		const parsed = parse_raw(input);
		const messages = parsed.errors.map((e) => e.message);
		expect(messages.some((m) => m.includes("not Sendable"))).toBe(true);
	});
});
