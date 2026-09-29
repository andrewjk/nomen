import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Nullable SCALAR values (`bool?`, `int?`, …) carry a companion `_has` flag
// (mirroring nullable structs) so `false`/`0` are distinguishable from
// `null`. Before this, scalars used an in-band `null == 0` representation:
// storing `false` in a `bool?` field read back as null.

describe("nullable scalar values", () => {
	test("bool?/int? fields distinguish false/0 from null", async () => {
		const input = `
class Config {
	pub var bool? flag = null
	pub var int? count = null
}

struct Pair {
	var bool? on
	var int? n
}

var c = Config()
if c.flag != null { Console.write("FLAG BUG\\n") }
c.flag = false
if c.flag == null { Console.write("FLAG NULL BUG\\n") } else { Console.write("flag false\\n") }
c.count = 0
if c.count == null { Console.write("COUNT NULL BUG\\n") } else { Console.write("count zero\\n") }
c.count = null
if c.count == null { Console.write("count cleared\\n") } else { Console.write("COUNT CLEAR BUG\\n") }

var p = Pair(true, 7)
Console.write("p=\\{p.on} \\{p.n}\\n")

var bool? local = false
if local == null { Console.write("LOCAL BUG\\n") } else { Console.write("local false\\n") }
local = null
if local == null { Console.write("local cleared\\n") }
`;
		await build_and_check_output(
			input,
			"nullable_scalar_fields",
			"flag false\ncount zero\ncount cleared\np=true 7\nlocal false\nlocal cleared\n",
		);
	});

	test("nullable scalar params and returns round-trip null", async () => {
		const input = `
func pass = (int? x, out int?) {
	return x
}

func is_set = (int? x, out bool) {
	return x != null
}

func find = (out int?) {
	return null
}

func or_default = (int? x, out int) {
	return x ?? 42
}

var a = pass(5)
if a == null { Console.write("A BUG\\n") } else { Console.write("a=5\\n") }
var b = pass(null)
if b == null { Console.write("b null\\n") } else { Console.write("B BUG\\n") }
Console.write("is_set(5)=\\{is_set(5)} is_set(null)=\\{is_set(null)}\\n")
var n = find()
if n == null { Console.write("find null\\n") } else { Console.write("N BUG\\n") }
Console.write("or_default(null)=\\{or_default(null)}\\n")
`;
		await build_and_check_output(
			input,
			"nullable_scalar_params",
			"a=5\nb null\nis_set(5)=true is_set(null)=false\nfind null\nor_default(null)=42\n",
		);
	});

	test("nullable scalar method params and returns", async () => {
		const input = `
class Store {
	pub var int? cached = null

	pub func set = (ref self, int? v) {
		self.cached = v
	}

	pub func get = (ref self, out int?) {
		return self.cached
	}
}

var s = Store()
s.set(9)
var got = s.get()
if got == null { Console.write("GET BUG\\n") } else { Console.write("got=9\\n") }
s.set(null)
var cleared = s.get()
if cleared == null { Console.write("cleared\\n") } else { Console.write("CLEAR BUG\\n") }
`;
		await build_and_check_output(input, "nullable_scalar_methods", "got=9\ncleared\n");
	});
});
