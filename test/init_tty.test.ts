import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `Init.is_tty` mirrors `process.stdout.isTTY`: it is `isatty(1)` at program
// start. The test harness captures stdout through a pipe, so the compiled
// binary always observes a NON-terminal stdout (`is_tty == false`) here — a
// deterministic value to assert against on both backends.
//
// These tests define their own `pub func main = (Init init)` entry point, so
// they use the `raw` parse path (parse_with_imports wraps source in a
// parameterless `main`, which would shadow the Init-taking entry).

const HEADER = `import System\n`;

describe("Init.is_tty", () => {
	test("is_tty is false when stdout is piped (test harness)", async () => {
		const input = `${HEADER}
pub func main = (Init init) {
    if init.is_tty {
        Console.write("tty")
    } else {
        Console.write("pipe")
    }
}
`;
		await build_and_check_output(input, "init_is_tty_piped", "pipe", true);
	});

	test("is_tty reads as a bool and round-trips through a local", async () => {
		const input = `${HEADER}
pub func main = (Init init) {
    var bool terminal = init.is_tty
    if terminal {
        Console.write("yes")
    } else {
        Console.write("no")
    }
}
`;
		await build_and_check_output(input, "init_is_tty_local", "no", true);
	});

	test("argc/args still work alongside is_tty", async () => {
		const input = `${HEADER}
pub func main = (Init init) {
    Console.write("\\{init.argc}")
    if init.is_tty {
        Console.write("tty")
    } else {
        Console.write("pipe")
    }
}
`;
		// The harness runs the binary with no forwarded program args, so argc
		// is 1 (program name only). stdout is piped, so is_tty is false.
		await build_and_check_output(input, "init_args_and_tty", "1pipe", true);
	});
});
