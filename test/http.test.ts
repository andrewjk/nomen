import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Http (System/Stream/Http.nm) reports failures through
// `Result<..., HttpError>` like File/Directory. The run test uses a
// connect-refused port on 127.0.0.1 so it is deterministic and never
// touches the network: get/post fail with `HttpError.connect` and
// `status` stays 0.

describe("Http Result API", () => {
	test("get/post Result shape parses and checks", () => {
		const input = `
var Http h = Http()
match h.get("http://127.0.0.1:1/") {
	case .ok(body) {
		Console.write(body)
	}
	case .error(e) {
		match e {
			case .dns -> Console.write("dns ")
			case .socket -> Console.write("socket ")
			case .connect -> Console.write("connect ")
			else -> Console.write("other ")
		}
	}
}
match h.post("http://127.0.0.1:1/", "hello=world") {
	case .ok(body) {
		Console.write(body)
	}
	case .error(e) {
		Console.write("post failed")
	}
}
Console.write("\\{h.status}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("get/post on a refused port yield HttpError.connect and status 0", async () => {
		const input = `
var Http h = Http()
match h.get("http://127.0.0.1:1/") {
	case .ok(body) {
		Console.write("body?! ")
	}
	case .error(e) {
		match e {
			case .connect -> Console.write("connect ")
			else -> Console.write("other ")
		}
	}
}
match h.post("http://127.0.0.1:1/", "hello=world") {
	case .ok(body) {
		Console.write("body?!")
	}
	case .error(e) {
		match e {
			case .connect -> Console.write("connect")
			else -> Console.write("other")
		}
	}
}
Console.write(" ")
Console.write("\\{h.status}")
`;
		await build_and_check_output(input, "http_connect_refused", "connect connect 0");
	});
});
