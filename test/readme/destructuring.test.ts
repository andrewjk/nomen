import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: destructuring", () => {
	test("tuple destructuring from a function return and a literal", () => {
		const input = `
func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}

pub func main = () {
    var [pname, page] = get_person(12)
    var [a, b] = [11, "hello"]
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
