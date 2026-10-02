import { defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/dist/**", "./temp/**", "./tests/**", "./test/out/**"],
		// Build the single precompiled system.o once before all tests; every
		// C-backend test links it instead of recompiling System per test.
		globalSetup: ["./test/system_lib_setup.ts"],
		// On a fully cold run every test recompiles its (small) user TU and
		// links the precompiled system object. That work is dominated by
		// process-spawn/clang/ld latency (each cycle is ~0.6s wall but only
		// ~0.1s CPU), so the suite is latency-bound, not CPU-bound — running
		// one worker per logical core keeps the machine busy. A generous
		// per-test timeout keeps worker-count contention (E-core scheduling,
		// spawn latency under load) from flaking a fully cold run; the prebuilt
		// System object keeps each test's actual work small.
		maxWorkers: 8,
		// 60s, not the 10s a few test files used to set inline (that was the
		// whole cold-run flake: `layout_container.test.ts` alone timed out 9
		// ways on a cold run, and `gui_typedef_collision` / `pidigits` too).
		// A per-test budget BELOW this global is a trap — the slowest legitimate
		// test (an ObjC/GUI build, which cannot use the precompiled system
		// object and so recompiles all of System per test, on both backends)
		// costs ~1.4s warm and ~2.7s solo-cold per test, and 4-8x that under
		// worker contention. Keep per-test overrides at or above this number.
		testTimeout: 60_000,
	},
});
