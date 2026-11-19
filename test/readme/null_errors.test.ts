import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("readme: null safety", () => {
	test("nullable types and the compile-time null tracking", () => {
		const input = `
var int? maybe = null        // any type can be nullable

var int? x = 5
const y = x + 1              // OK — the compiler knows x is not null

var int? n = null
const bad = n + 1            // Error: Variable 'n' is null
`;
		const errors = compile_main(input, { arch: "c", platform: "macos" });
		expect(errors.some((e) => e.message.includes("Variable 'n' may be null"))).toBe(true);
	});

	test("?. chains read on the non-null path; ?? picks the fallback", () => {
		const input = `
struct Profile {
    var int score
}

func find = (int id, out Profile?) {
    if id == 1 {
        return Profile(7)
    }
    return null
}

func score_or = (int id, out int) {
    var p = find(id)
    return p?.score ?? 0     // the fallback runs only when p is null
}
`;
		expect(compile_module(input, { arch: "c", platform: "macos" })).toEqual([]);
	});
});

describe("readme: error handling", () => {
	test("error enums, T ! E results, and lifted bare returns", () => {
		const input = `
error FetchError {
    case notfound
}

func fetch = (string url, out int ! FetchError) {
    if url == "" {
        return .notfound     // lifts to Result.fail
    }
    return 7                 // lifts to Result.ok
}

var result = fetch("u")
match result {
    case .ok(value) -> Console.write("\\{value}")
    case .fail(err) -> Console.write("failed")
}

const body = fetch("example.com") !! 0   // the value, or 0 on failure

func reload = (string url, out int ! FetchError) {
    return fetch(url)!                   // propagate to the caller
}
`;
		expect(compile_main(input, { arch: "c", platform: "macos" })).toEqual([]);
	});

	test("try expr catch handles the error side at the point of encounter", () => {
		const input = `
error FetchError {
    case notfound
}

func fetch = (string url, out int ! FetchError) {
    if url == "" {
        return .notfound
    }
    return 7
}

func describe = (string url, out int) {
    return try fetch(url) catch {
        case .notfound -> -1
    }
}
`;
		expect(compile_module(input, { arch: "c", platform: "macos" })).toEqual([]);
	});
});
