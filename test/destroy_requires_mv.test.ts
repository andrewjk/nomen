import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A struct declaring `#destroy` must be single-owner (`mv struct`): a Copyable
// destructor would run once per copy (the review probe printed `destroy 3`
// twice) and every copy would release the same resource. The declaration is
// rejected unless spelled `mv struct`, and the destructor then runs exactly
// once per owning binding at scope exit. Verified on both native backends.
const SRC = `
import System

mv struct Transaction {
	var int handle

	func #init = (ref self, int handle) {
		self.handle = handle
	}

	func #destroy = (self) {
		Console.write_line("destroy \\{self.handle}")
	}
}

pub func main = () {
	var t = Transaction(3)
	mv t2 = t
	Console.write_line("scope end")
}
`;

describe("destroy requires mv", () => {
	test("the destructor runs exactly once at scope exit", async () => {
		await build_and_check_output(SRC, "destroy_requires_mv_once", "scope end\ndestroy 3\n", true);
	});
});
