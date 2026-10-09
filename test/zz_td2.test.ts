import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

test("plain mv struct method write after ctor seed", async () => {
	await build_and_check_output(
		`
mv struct P {
	var string name = "anon"
	func rename = (ref self, string n) {
		self.name = n.copy()
	}
}
var P p = P()
p.rename("rex")
Console.write(p.name)
`,
		"probe_plain_method_seed_write",
		"rex",
	);
});
