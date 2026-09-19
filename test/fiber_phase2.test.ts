import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// Phase 2 of ASYNC.md — park-aware blocking and cancellation reaching
// parked fibers:
//   * Channel.receive parks the fiber (frees the worker) and resumes on send
//   * Mutex.lock parks instead of blocking
//   * Task.cancel()/nursery timeout/race wake or reach passive waiters
// Acceptance: nested fibers, race mode, and timeout cancellation all work
// with fibers. Each runtime test loops over the C and aarch64 backends.

const ARCHITECTURES = ["c", "aarch64"] as const;
const OPTIONS = { audit: true } as const;

describe("park-aware Channel", () => {
	test("a fiber parked in receive wakes on a thread producer's send", async () => {
		const input = `
import System

func producer = (Channel ch) {
	ch.send(42)
}

func consumer = (Channel ch) {
	var uint64 v = ch.receive()   // parks the fiber until the message arrives
	if v == 42 {
		Console.write_line("fiber received")
	}
}

pub func main = () {
	var Channel ch = Channel()
	async {
		Thread(producer(ch)).start()
		var f = Fiber(consumer(ch)).start()
		f.wait()
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_p2_channel_wake_${arch}`, result, "fiber received\n", options);
		}
	});

	test("a fiber parked in receive resumes when the main thread sends", async () => {
		const input = `
import System

func relay = (Channel ca, Channel cb) {
	var uint64 v = ca.receive()   // parked
	cb.send(v + 1)
}

pub func main = () {
	var Channel ca = Channel()
	var Channel cb = Channel()
	var f = Fiber(relay(ca, cb)).start()
	ca.send(41)
	var uint64 r = cb.receive()
	f.wait()
	if r == 42 {
		Console.write_line("parked receive ok")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_p2_channel_main_${arch}`, result, "parked receive ok\n", options);
		}
	});

	test("a cancelled fiber waiting on an empty channel returns instead of hanging", async () => {
		const input = `
import System

func blocked = (Channel ch) {
	var uint64 v = ch.receive()   // nobody will send
	if Task.current_cancelled() {
		Console.write_line("observed cancel")
	}
}

pub func main = () {
	var Channel ch = Channel()
	async(timeout: 50) {
		// No wait here: the block's deadline is enforced at its join, and the
		// join cancels the parked fiber (which then observes cancellation).
		Fiber(blocked(ch)).start()
	}
	Console.write_line("nursery exited")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(
				`fiber_p2_channel_timeout_${arch}`,
				result,
				"observed cancel\nnursery exited\n",
				options,
			);
		}
	});
});

describe("park-aware Mutex", () => {
	test("two fibers contend for a mutex and interleave cooperatively", async () => {
		// A holds the lock across a yield; B parks on the contended lock and
		// resumes once A unlocks. Cooperative mode keeps the order deterministic.
		const input = `
import System

func worker = (Mutex m, Channel ch, uint64 id) {
	m.lock()
	ch.send(id)
	Fiber.yield()
	ch.send(id + 10)
	m.unlock()
}

pub func main = () {
	Fiber.set_cooperative(true)
	var Mutex m = Mutex()
	var Channel ch = Channel()
	var a = Fiber(worker(m, ch, 1)).start()
	var b = Fiber(worker(m, ch, 2)).start()
	a.wait()
	b.wait()
	var string order = ""
	var int i = 0
	while i < 4 {
		var uint64 v = ch.receive()
		order = order + v.to_string() + ","
		i = i + 1
	}
	Console.write_line(order)
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			// A: 1, 11 (holds the lock through the yield); then B: 2, 12.
			await check_output(`fiber_p2_mutex_${arch}`, result, "1,11,2,12,\n", options);
		}
	});

	test("a threaded-model fiber parks on a lock held across a park", async () => {
		// The holder locks, signals, and parks ON THE LOCK (its worker is
		// freed while it still owns the mutex). The contender must park on
		// the mutex's wait list rather than block its worker — unlock wakes
		// it. This is the shape that pinned a pool worker before the
		// threaded-model mutex park (see ASYNC.md Phase 2).
		const input = `
import System

func holder = (Mutex m, Channel go, Channel ack) {
	m.lock()
	go.send(1)
	var uint64 x = ack.receive()
	m.unlock()
}

func contender = (Mutex m, Channel done) {
	m.lock()
	m.unlock()
	done.send(1)
}

pub func main = () {
	var Mutex m = Mutex()
	var Channel go = Channel()
	var Channel ack = Channel()
	var Channel done = Channel()
	async {
		Thread(holder(m, go, ack)).start()
		Thread(contender(m, done)).start()
		// The block joins its spawns at exit, so the release choreography
		// runs here — the holder parks on ack while holding the lock.
		var uint64 g = go.receive()
		ack.send(1)
		done.receive()
	}
	Console.write_line("contended ok")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_p2_mutex_threaded_${arch}`, result, "contended ok\n", options);
		}
	});
});

describe("cancellation reaches fibers", () => {
	test("Task.cancel wakes a fiber parked on that task's future", async () => {
		const input = `
import System

func long_task = (uint64 n, out uint64) {
	var int i = 0
	while i < 1000000000 {
		if Task.current_cancelled() {
			return 7
		}
		i = i + 1
	}
	return 9
}

func waiter = (Task<uint64> handle, Channel ch) {
	var Task<uint64> t = handle
	var uint64 r = t.result_uint64()   // parks until t completes or is cancelled
	ch.send(r)
}

pub func main = () {
	var Channel ch = Channel()
	async {
		var t = Thread(long_task(0)).start()
		var f = Fiber(waiter(t, ch)).start()
		t.cancel()
		var uint64 r = ch.receive()
		f.wait()
		Console.write_line("fiber woke")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_p2_cancel_wake_${arch}`, result, "fiber woke\n", options);
		}
	});

	test("async(mode: race) exits on the first fiber and cancels the loser", async () => {
		const input = `
import System

func quick = (Channel ch) {
	ch.send(1)
}

func slow = (Channel ch) {
	var int i = 0
	while i < 100000000 {
		if Task.current_cancelled() {
			return
		}
		i = i + 1
	}
	ch.send(99)
}

pub func main = () {
	var Channel ch = Channel()
	async(mode: race) {
		Fiber(slow(ch)).start()
		Fiber(quick(ch)).start()
	}
	var uint64 v = ch.receive()
	if v == 1 {
		Console.write_line("quick fiber won")
	} else {
		Console.write_line("slow fiber won")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_p2_race_${arch}`, result, "quick fiber won\n", options);
		}
	});
});
