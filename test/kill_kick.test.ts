import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A fiber parked on a channel whose producer is cancelled by the nursery
// timeout: nothing wakes the receiver (cancel only wakes the producer's own
// waiters), so the nursery join hangs forever. The kill-trampoline's
// cooperative stand-in: at the timed-out join, every fiber whose task was
// cancelled and that is parked on a primitive waitq gets scheduled, so it
// resumes THROUGH the primitive's own locks, unlinks itself, observes the
// cancellation, and exits.

describe("cancelled parked fibers are kicked at a timed-out join", () => {
	test("receiver parked on a channel outlives its cancelled producer", async () => {
		const input = `import System

func never_sends = (Channel ch) {
	// A well-behaved task polls cancellation; the sleep slices keep the
	// flag observable. (A task that ignores cancellation — one long
	// unobservable sleep, a tight loop — hangs the join by design; that is
	// the documented kill-trampoline gap, not a soundness hole.)
	while !Task.current_cancelled() {
		Time.sleep_ms(50)
	}
}

func receiver = (Channel ch) {
	var uint64 v = ch.receive() // parks here; returns the zero value once cancelled
	Console.write_line("receiver done")
}

pub func main = () {
	var Channel ch = Channel()
	async(timeout: 300) {
		Thread(never_sends(ch)).start()
		Thread(receiver(ch)).start()
	}
	Console.write_line("survived")
}
`;
		await build_and_check_output(input, "kill_kick_channel", "receiver done\nsurvived\n", true, {
			audit: false,
		});
	}, 30000);
});
