import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// An OWNED class result used inline as a method receiver
// (`Thread(fn()).start().result()`) must be anchored: the `move out T`
// method handed the caller a fresh instance, and an unanchored receiver
// never reaches `#destroy` — for a `Task<T>` handle that destroy IS the
// future release. The checker hoists the receiver into a scoped `var`
// declaration so the scope-exit cleanup runs, exactly like the stored
// handle form. Borrowed (shared-reference) returns must NOT be hoisted —
// destroying one would double-free an instance someone else owns.

describe("owned class result as receiver", () => {
	test("chained Fiber(...).start().result() runs clean under audit", async () => {
		const input = `import System

func get_user = (uint64 id, out string) {
	Time.sleep_ms(20)
	return "ada"
}

pub func main = () {
	async {
		const user = Fiber(get_user(1)).start().result()
		Console.write_line(user)
	}
}
`;
		await build_and_check_output(input, "owned_recv_chained", "ada\n", true);
	});

	test("chained Thread(...).start().result_uint64() runs clean under audit", async () => {
		const input = `import System

func work = (uint64 n, out uint64) {
	return n * 2
}

pub func main = () {
	async {
		var uint64 r = Thread(work(21)).start().result_uint64()
		Console.write_line(r.to_string())
	}
}
`;
		await build_and_check_output(input, "owned_recv_chained_u64", "42\n", true);
	});

	test("a shared-reference receiver is not hoisted or destroyed", async () => {
		const input = `import System

class Engine {
	pub var int hp = 0

	pub func set_hp = (ref self, int hp) {
		self.hp = hp
	}
}

class Car {
	move Engine engine

	pub func #init = (self, move Engine e) {
		self.engine = e
	}

	pub func engine_of = (ref self, out Engine) {
		return self.engine
	}
}

pub func main = () {
	var car = Car(Engine())
	car.engine_of().set_hp(200)
	Console.write_line(car.engine.hp.to_string())
}
`;
		await build_and_check_output(input, "owned_recv_shared", "200\n", true);
	});
});
