import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("readme: compile-time metaprogramming", () => {
	test("#if selects code per compile target", () => {
		const body = `
#if META.arch == "c" {
    Console.write_line("portable path")
} else {
    Console.write_line("not c")
}
`;
		expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
		expect(compile_main(body, { arch: "aarch64", platform: "macos" })).toEqual([]);
	});

	test("attributes attach metadata; #for unrolls over the fields", () => {
		const input = `
@sql_table("users")
pub mv struct User {
    @rename("user_name")
    mv string name
    var int age
}

func keys<T> = (T value, out string) {
    var s = META.info(T).attr("sql_table") + ": "
    #for field of META.info(T).fields {
        if field.has_attr("rename") {
            s = s + field.attr("rename")
        } else {
            s = s + field.name
        }
        s = s + ","
    }
    return s
}

Console.write_line(keys(User("jane", 31)))
`;
		expect(compile_module(input)).toEqual([]);
	});
});
