import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// CLOSURE.md Phase 3b: Thread/Fiber are real library classes.
// The construction packs its arguments eagerly into a task closure and
// yields a storable value; .start() / .detach() / .start_on(buf) launch
// it — from the construction expression itself OR a stored binding — and
// #destroy enforces must-start (a never-started value is a programming
// error that aborts with an explanation).

describe("Thread/Fiber as library values (Phase 3b)", () => {
	test("chained start still works", async () => {
		const input = `import System

func work = (int n, out uint64) {
	return n * 2
}

pub func main = () {
	var t = Thread(work(21)).start()
	Console.write_line(t.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "thread_struct_chained", "42\n", true);
	});

	test("a stored Thread can be started later", async () => {
		const input = `import System

func work = (int n, out uint64) {
	return n + 1
}

pub func main = () {
	var t = Thread(work(41))
	Console.write_line("made")
	var h = t.start()
	Console.write_line(h.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "thread_struct_store_later", "made\n42\n", true);
	});

	test("a stored Fiber can be started later (start_on too)", async () => {
		const input = `import System

func step = (out uint64) {
	Fiber.yield()
	return 42
}

pub func main = () {
	var f = Fiber(step())
	var uint64[2048] buf
	var h = f.start_on(buf)
	Console.write_line(h.result().to_string())
}
`;
		await build_and_check_output(input, "thread_struct_fiber_store", "42\n", true);
	});

	test("a stored daemon detaches later", async () => {
		const input = `import System

func bump = (Channel report) {
	report.send(1)
}

pub func main = () {
	var Channel report = Channel()
	var d = Thread(bump(report))
	d.detach()
	var uint64 up = report.receive() // the daemon is up
	if up == 1 {
		Console.write_line("detached")
	}
}
`;
		// Audit off, mirroring daemon.test.ts: a daemon killed or still
		// running at process exit leaks its task closure by construction —
		// the detached runner disposes it, but the audit check at main exit
		// races it.
		await build_and_check_output(input, "thread_struct_detach_store", "detached\n", true, {
			audit: false,
		});
	});

	test("destroying an unstarted Thread aborts with an explanation", async () => {
		const input = `import System

func work = (int n, out uint64) {
	return n
}

pub func main = () {
	var t = Thread(work(1))
	Console.write_line("made")
}
`;
		let failed = false;
		try {
			await build_and_check_output(input, "thread_struct_must_start", "made\n", true, {
				audit: false,
			});
		} catch (e) {
			failed = true;
			const err = e as { stderr?: string; message?: string };
			const text = (err.stderr ?? "") + (err.message ?? "");
			expect(text).toContain("was never started");
		}
		expect(failed).toBe(true);
	});

	test("a stored Thread starts inside a nursery and is joined", async () => {
		const input = `import System

func work = (Channel ch) {
	ch.send(7)
}

pub func main = () {
	var Channel ch = Channel()
	async {
		var t = Thread(work(ch))
		var h = t.start()
	}
	var uint64 v = ch.receive()
	Console.write_line(v.to_string())
}
`;
		await build_and_check_output(input, "thread_struct_nursery_store", "7\n", true);
	});
});
