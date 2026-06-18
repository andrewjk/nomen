import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./ziglings/parse_with_imports";

test("lru -- build", async () => {
	const input = `
import System
import Map
import Buffer
import Init
import int

pub func main = () {
	var int size = 10
	var int n = 100

	var int M = size * 10
	var int rng0_state = 0
	var int rng1_state = 1

	var Map<int, int> lru = Map<int, int>()
	var Buffer order = Buffer()
	order.alloc_int(size)
	var int order_len = 0

	var int hit = 0
	var int missed = 0

	var int i = 0
	while i < n {
		rng0_state = (1103515245 * rng0_state + 12345) % 2147483648
		var int n0 = rng0_state % M

		if lru.has(n0) {
			lru.set(n0, n0)
			var int find = 0
			while find < order_len {
				if order.load_int(find) == n0 {
					if find < order_len - 1 {
						var int sh = find
						while sh < order_len - 1 {
							order.store_int(sh, order.load_int(sh + 1))
							sh = sh + 1
						}
					}
					order.store_int(order_len - 1, n0)
					break
				}
				find = find + 1
			}
		} else {
			switch {
				case order_len >= size {
					var int oldest = order.load_int(0)
					lru.remove(oldest)
					var int j = 0
					while j < order_len - 1 {
						order.store_int(j, order.load_int(j + 1))
						j = j + 1
					}
					order.store_int(order_len - 1, n0)
					lru.set(n0, n0)
				}
				else {
					order.store_int(order_len, n0)
					order_len = order_len + 1
					lru.set(n0, n0)
				}
			}
		}

		rng1_state = (1103515245 * rng1_state + 12345) % 2147483648
		var int n1 = rng1_state % M

		if lru.has(n1) {
			hit = hit + 1
			var int find2 = 0
			while find2 < order_len {
				if order.load_int(find2) == n1 {
					if find2 < order_len - 1 {
						var int sh2 = find2
						while sh2 < order_len - 1 {
							order.store_int(sh2, order.load_int(sh2 + 1))
							sh2 = sh2 + 1
						}
					}
					order.store_int(order_len - 1, n1)
					break
				}
				find2 = find2 + 1
			}
		} else {
			missed = missed + 1
		}

		i = i + 1
	}

	Console.write("\\{hit}\\n")
	Console.write("\\{missed}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	await check_output("lru_small", result, "4\n96");
});
