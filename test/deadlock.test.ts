import { exec, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";
import { postprocess_macos } from "./postprocess";

const execPromise = util.promisify(exec);

// The runtime deadlock detector (Go's "all goroutines are asleep" model,
// docs/ASYNC.md "Deadlock detection"): neither regression shape here is
// statically catchable, so the detector is the only net. Both used to hang
// silently; now they must abort with exit code 2 and a wait-graph dump on
// stderr. Each runtime test loops over the C and aarch64 backends.

const ARCHITECTURES = ["c", "aarch64"] as const;

/**
 * Build, compile, and run a program expected to trip the deadlock detector.
 * A silent hang (the pre-detector behavior) is killed by spawnSync's
 * timeout: status is null and stderr is empty, which fails the assertions
 * below with the captured stderr shown.
 */
async function expect_deadlock_abort(
	name: string,
	input: string,
	arch: "c" | "aarch64",
	stderr_fragments: string[],
): Promise<void> {
	const parsed = parse_raw(input);
	expect(parsed.errors).toEqual([]);
	const options = { arch, audit: false };
	const result = build(parsed.root, options);
	const folder = path.resolve(".", "test", "out", arch, name);
	fs.mkdirSync(folder, { recursive: true });
	const code_ext = arch === "aarch64" ? ".s" : process.platform === "darwin" ? ".m" : ".c";
	const codefile = path.join(folder, `main${code_ext}`);
	fs.writeFileSync(codefile, postprocess_macos(result.code, false, arch));
	if (result.headers) fs.writeFileSync(path.join(folder, "main.h"), result.headers);
	const comp_ext = process.platform === "darwin" ? ".m" : ".c";
	let link_inputs = codefile;
	if (result.companion) {
		const companionfile = path.join(folder, `main_companion${comp_ext}`);
		fs.writeFileSync(companionfile, result.companion);
		link_inputs += ` ${companionfile}`;
	}
	const outfile = path.join(folder, "main.out");
	await execPromise(`clang -o ${outfile} ${link_inputs}`, { maxBuffer: 10 * 1024 * 1024 });
	const run = spawnSync(outfile, { cwd: folder, encoding: "utf-8", timeout: 30000 });
	expect(run.status).toBe(2);
	expect(run.stderr).toContain("fatal error: all tasks are asleep - deadlock!");
	for (const fragment of stderr_fragments) {
		expect(run.stderr).toContain(fragment);
	}
}

describe("deadlock detection", () => {
	test("join-before-communicate: a task parked on the post-join send aborts the join", async () => {
		const input = `
import System

func waiter = (Channel ack) {
	var uint64 v = ack.receive()   // parks: nobody sends before the join
}

pub func main = () {
	var Channel ack = Channel()
	async {
		Fiber(waiter(ack)).start()
	}
	ack.send(1)   // unreachable: the join above can never complete
	Console.write_line("done")
}
`;
		for (const arch of ARCHITECTURES) {
			await expect_deadlock_abort(`deadlock_join_before_send_${arch}`, input, arch, [
				"parked on channel receive",
			]);
		}
	});

	test("intra-block cycle: mutex held across a park, its only releaser parked too", async () => {
		const input = `
import System

func a_side = (Mutex m, Channel ch) {
	m.lock()
	var uint64 v = ch.receive()   // parks holding m
	m.unlock()
}

func b_side = (Mutex m, Channel ch) {
	m.lock()      // parks on m — held by a_side, which parks on ch
	ch.send(1)    // the only send, never reached
	m.unlock()
}

pub func main = () {
	var Mutex m = Mutex()
	var Channel ch = Channel()
	async {
		Fiber(a_side(m, ch)).start()
		Fiber(b_side(m, ch)).start()
	}
	Console.write_line("done")
}
`;
		for (const arch of ARCHITECTURES) {
			await expect_deadlock_abort(`deadlock_mutex_channel_cycle_${arch}`, input, arch, [
				"parked on channel receive",
				"parked on mutex",
				"held by task",
			]);
		}
	});

	test("no false positive: a busy Thread task is the waker, the graph is not stuck", async () => {
		// Main commits to the fiber's result while the fiber is parked on a
		// channel and a Thread task is mid-sleep before the send. The pool
		// is NOT idle (the sender's worker is busy), so the detector must
		// stay quiet and the send must rescue the join.
		const input = `
import System

func late_sender = (Channel ch) {
	Time.sleep_ms(100)
	ch.send(42)
}

func waiter = (Channel ch, out uint64) {
	return ch.receive()
}

pub func main = () {
	var Channel ch = Channel()
	async {
		Thread(late_sender(ch)).start()
		var f = Fiber(waiter(ch)).start()
		var uint64 v = f.result()
		if v == 42 {
			Console.write_line("rescued")
		}
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`deadlock_thread_waker_${arch}`, result, "rescued\n", options);
		}
	});
});
