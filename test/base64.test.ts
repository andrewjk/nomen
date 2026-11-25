import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// System::Text::Base64 and Hex against RFC 4648 (sections 4, 5, 8 and the
// section 10 test vectors), run on aarch64, C and JS.

const HELPERS = `
func show = (view string text) {
	match Base64.decode(text) {
		case .ok(b) -> Console.write_line("ok \\{b}")
		case .fail(e) {
			match e {
				case .invalid_length -> Console.write_line("invalid_length")
				case .invalid_character(p) -> Console.write_line("invalid_character \\{p}")
				case .invalid_padding -> Console.write_line("invalid_padding")
			}
		}
	}
}

func show_url = (view string text) {
	match Base64.decode_url(text) {
		case .ok(b) -> Console.write_line("ok \\{Hex.encode(b)}")
		case .fail(e) {
			match e {
				case .invalid_length -> Console.write_line("invalid_length")
				case .invalid_character(p) -> Console.write_line("invalid_character \\{p}")
				case .invalid_padding -> Console.write_line("invalid_padding")
			}
		}
	}
}

func show_hex = (view string text) {
	match Hex.decode(text) {
		case .ok(b) -> Console.write_line("ok \\{b}")
		case .fail(e) {
			match e {
				case .invalid_length -> Console.write_line("invalid_length")
				case .invalid_character(p) -> Console.write_line("invalid_character \\{p}")
			}
		}
	}
}
`;

async function run(name: string, body: string, expected: string): Promise<void> {
	const input = `
import System
import System::Text
${HELPERS}
pub func main = () {
${body}
}
`;
	await build_and_check_output(input, name, expected, true, { js: true });
}

const RFC_INPUTS = ["", "f", "fo", "foo", "foob", "fooba", "foobar"];
const RFC_BASE64 = ["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"];

describe("Base64 encode", () => {
	test("RFC 4648 section 10 vectors, padded", async () => {
		await run(
			"base64_encode_rfc",
			RFC_INPUTS.map((s) => `Console.write_line("[" + Base64.encode("${s}") + "]")`).join("\n"),
			RFC_BASE64.map((s) => `[${s}]\n`).join(""),
		);
	});

	test("URL-safe alphabet omits padding", async () => {
		await run(
			"base64_encode_url",
			`
${RFC_INPUTS.map((s) => `Console.write_line("[" + Base64.encode_url("${s}") + "]")`).join("\n")}
Console.write_line(Base64.encode("\\xFB\\xFF") + " " + Base64.encode_url("\\xFB\\xFF"))
Console.write_line(Base64.encode("\\xFB\\xEF\\xBE") + " " + Base64.encode_url("\\xFB\\xEF\\xBE"))
`,
			RFC_BASE64.map((s) => `[${s.replace(/=/g, "")}]\n`).join("") + "+/8= -_8\n++++ ----\n",
		);
	});

	// Bytes 1-255: a decoded string holding a NUL byte is truncated when the
	// native backends copy it into the Result (see FOLLOWUP.md, "Native
	// string copies are not binary-safe"); encoding byte 0 is covered here.
	test("every byte value round-trips through both alphabets", async () => {
		const bytes = Buffer.from(Array.from({ length: 255 }, (_, i) => i + 1));
		await run(
			"base64_all_bytes",
			`
var sb = StringBuilder()
for i of 1 .. 256 {
	sb.append_char(i as char)
}
const data = sb.to_string()
Console.write_line(Base64.encode("\\x00\\x00\\x00\\x00"))
const std = Base64.encode(data)
const url = Base64.encode_url(data)
Console.write_line(std)
Console.write_line(url)
match Base64.decode(std) {
	case .ok(b) -> Console.write_line("\\{b == data}")
	case .fail(e) -> Console.write_line("fail")
}
match Base64.decode_url(url) {
	case .ok(b) -> Console.write_line("\\{b == data}")
	case .fail(e) -> Console.write_line("fail")
}
`,
			`AAAAAA==\n${bytes.toString("base64")}\n${bytes.toString("base64url")}\ntrue\ntrue\n`,
		);
	});
});

describe("Base64 decode", () => {
	test("RFC 4648 section 10 vectors", async () => {
		await run(
			"base64_decode_rfc",
			RFC_BASE64.map((s) => `show("${s}")`).join("\n"),
			RFC_INPUTS.map((s) => `ok ${s}\n`).join(""),
		);
	});

	test("URL-safe decode accepts padded and unpadded input", async () => {
		await run(
			"base64_decode_url",
			`
show_url("Zg")
show_url("Zg==")
show_url("Zm8")
show_url("Zm8=")
show_url("-_8")
show_url("-_8=")
show_url("----")
`,
			"ok 66\nok 66\nok 666f\nok 666f\nok fbff\nok fbff\nok fbefbe\n",
		);
	});

	test("invalid input reports the error", async () => {
		await run(
			"base64_decode_errors",
			`
show("Zg")
show("Zg=")
show("Zm9vY")
show("Zm9v!A==")
show("Zm9v\\nYmE")
show("-_8=")
show("Zg=a")
show("Z===")
show("====")
show("Zh==")
show("Zm9=")
show_url("Z")
show_url("Zg=")
show_url("+/8")
show_url("Zh")
`,
			"invalid_length\n" +
				"invalid_length\n" +
				"invalid_length\n" +
				"invalid_character 4\n" +
				"invalid_character 4\n" +
				"invalid_character 0\n" +
				"invalid_padding\n" +
				"invalid_padding\n" +
				"invalid_padding\n" +
				"invalid_padding\n" +
				"invalid_padding\n" +
				"invalid_length\n" +
				"invalid_padding\n" +
				"invalid_character 0\n" +
				"invalid_padding\n",
		);
	});
});

describe("Hex", () => {
	test("RFC 4648 base16 vectors, lowercase out, either case in", async () => {
		await run(
			"hex_rfc",
			`
${RFC_INPUTS.map((s) => `Console.write_line("[" + Hex.encode("${s}") + "]")`).join("\n")}
Console.write_line(Hex.encode("\\x00\\x7F\\x80\\xFF"))
show_hex("666F6F626172")
show_hex("666f6F626172")
show_hex("")
show_hex("666")
show_hex("6g")
show_hex("x6")
`,
			"[]\n[66]\n[666f]\n[666f6f]\n[666f6f62]\n[666f6f6261]\n[666f6f626172]\n" +
				"007f80ff\n" +
				"ok foobar\nok foobar\nok \ninvalid_length\ninvalid_character 1\ninvalid_character 0\n",
		);
	});
});
