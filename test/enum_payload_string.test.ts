import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Ownership of strings inside enum-with-data payloads (C backend): case-init
// strdups string args (construction is an ownership copy) and enum locals
// free their payload at scope exit. These encode that contract.

test("heap string local returned in enum payload from method", async () => {
	const input = `
struct Maker {
	func make = (out Option<string>) {
		const string s = "abc".to_string()
		return .some(s)
	}
}

var Maker m = Maker()
var Option<string> r = m.make()
match r {
	case .some(t) -> Console.write("got:\\{t}")
	case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_payload_return", "got:abc");
});

test("local enum payload freed at scope exit, producer local unaffected", async () => {
	const input = `
const string s = "xyz".to_string()
var Option<string> r = Option<string>.some(s)
Console.write("s:\\{s}")
match r {
	case .some(t) -> Console.write(" t:\\{t}")
	case .none -> Console.write(" none")
}
`;
	await build_and_check_output(input, "enum_payload_local", "s:xyz t:xyz");
});

test("returning an enum local transfers payload ownership", async () => {
	const input = `
struct Picker {
	func pick = (bool ok, out Option<string>) {
		var Option<string> r = Option<string>.some("kept")
		if !ok {
			r = Option<string>.none
		}
		return r
	}
}

var Picker p = Picker()
match p.pick(true) {
	case .some(t) -> Console.write("kept:\\{t}")
	case .none -> Console.write("none")
}
match p.pick(false) {
	case .some(t) -> Console.write("kept:\\{t}")
	case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_payload_transfer", "kept:keptnone");
});
