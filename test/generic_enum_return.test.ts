import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("generic enum return from a generic-struct method", () => {
	test("Option<T> return monomorphizes and runs", async () => {
		const input = `
struct Holder<T> {
    var T item
    var bool has

    pub func try_get = (self, out Option<T>) {
        if self.has {
            return Option<T>.some(self.item)
        }
        var Option<T> none = Option<T>.none
        return none
    }
}
var Holder<string> h = Holder<string>("hello", true)
var Option<string> opt = h.try_get()
Console.write_line(match opt {
    case .some(v) -> v
    case .none -> "missing"
})
var Holder<int> empty = Holder<int>(0, false)
var Option<int> absent = empty.try_get()
Console.write_line(match absent {
    case .some(v) -> v.to_string()
    case .none -> "missing"
})
`;
		await build_and_check_output(input, "generic_enum_return", "hello\nmissing");
	});
});
