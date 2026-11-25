import crypto from "node:crypto";

import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// System::Crypto::Sha256 and Hmac against published vectors (FIPS 180-4 /
// NIST CSRC examples, RFC 4231), run on aarch64, C and JS. Boundary
// lengths are cross-checked against Node's own SHA-256.

function program(body: string, helpers = ""): string {
	return `
import System
import System::Crypto
import System::Text
${helpers}
pub func main = () {
${body}
}
`;
}

async function run(name: string, body: string, expected: string, helpers = ""): Promise<void> {
	await build_and_check_output(program(body, helpers), name, expected, true, { js: true });
}

const sha = (data: string | Buffer): string =>
	crypto.createHash("sha256").update(data).digest("hex");

describe("Sha256 published vectors", () => {
	test("empty, one-block and two-block messages (FIPS 180-4)", async () => {
		await run(
			"sha256_fips_vectors",
			`
Console.write_line(Hex.encode(Sha256.hash("")))
Console.write_line(Hex.encode(Sha256.hash("abc")))
Console.write_line(Hex.encode(Sha256.hash("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))
Console.write_line(Hex.encode(Sha256.hash("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")))
`,
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" +
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n" +
				"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1\n" +
				"cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1\n",
		);
	});

	test("one million 'a' (FIPS 180-4 long message)", async () => {
		await run(
			"sha256_million_a",
			`
const data = "a" * 1000000
Console.write_line(Hex.encode(Sha256.hash(data)))
`,
			"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0\n",
		);
	});
});

describe("Sha256 incremental", () => {
	test("chunked updates match the one-shot digest, and finish resets", async () => {
		const msg =
			"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
		await run(
			"sha256_incremental",
			`
const msg = "${msg}"
const expected = Hex.encode(Sha256.hash(msg))
var sizes = [1, 3, 7, 63, 64, 65, 200]
var hasher = Sha256()
for size of sizes {
	var i = 0
	while i < msg.length; i += size {
		var end = i + size
		if end > msg.length {
			end = msg.length
		}
		hasher.update(msg.substring(i, end))
	}
	const got = Hex.encode(hasher.finish())
	Console.write("\\{got == expected} ")
}
hasher.update("ab")
hasher.update("")
hasher.update("c")
Console.write_line(Hex.encode(hasher.finish()))
`,
			"true true true true true true true ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n",
		);
	});

	test("padding boundary lengths match Node's SHA-256", async () => {
		const lengths = [55, 56, 57, 63, 64, 65, 119, 120, 128];
		const expected = lengths.map((n) => sha("a".repeat(n))).join("\n") + "\n";
		await run(
			"sha256_boundaries",
			`
const lengths = [${lengths.join(", ")}]
for n of lengths {
	Console.write_line(Hex.encode(Sha256.hash("a" * n)))
}
`,
			expected,
		);
	});

	test("every byte value hashes as binary data", async () => {
		const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
		await run(
			"sha256_all_bytes",
			`
var sb = StringBuilder()
for i of 0 .. 256 {
	sb.append_char(i as char)
}
const data = sb.to_string()
Console.write_line(Hex.encode(Sha256.hash(data)))
`,
			sha(bytes) + "\n",
		);
	});
});

// RFC 4231 section 4 test cases. Keys and data are built with string
// repetition or byte loops, so the same bytes reach every backend.

describe("Hmac (RFC 4231)", () => {
	test("test cases 1-4", async () => {
		await run(
			"hmac_rfc4231_basic",
			`
Console.write_line(Hex.encode(Hmac.sha256("\\x0b" * 20, "Hi There")))
Console.write_line(Hex.encode(Hmac.sha256("Jefe", "what do ya want for nothing?")))
Console.write_line(Hex.encode(Hmac.sha256("\\xaa" * 20, "\\xdd" * 50)))
var kb = StringBuilder()
for i of 1 .. 26 {
	kb.append_char(i as char)
}
const key4 = kb.to_string()
Console.write_line(Hex.encode(Hmac.sha256(key4, "\\xcd" * 50)))
`,
			"b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7\n" +
				"5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843\n" +
				"773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe\n" +
				"82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b\n",
		);
	});

	test("test case 5 (truncated to 128 bits)", async () => {
		await run(
			"hmac_rfc4231_truncated",
			`
const tag = Hex.encode(Hmac.sha256("\\x0c" * 20, "Test With Truncation"))
Console.write_line(tag.substring(0, 32))
`,
			"a3b6167473100ee06e0c796c2955552b\n",
		);
	});

	test("test cases 6-7 (key longer than the block)", async () => {
		await run(
			"hmac_rfc4231_long_key",
			`
const key = "\\xaa" * 131
Console.write_line(Hex.encode(Hmac.sha256(key, "Test Using Larger Than Block-Size Key - Hash Key First")))
Console.write_line(Hex.encode(Hmac.sha256(key, "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.")))
`,
			"60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54\n" +
				"9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2\n",
		);
	});

	test("raw digests chain as keys (SigV4 signing-key derivation)", async () => {
		const hmac = (key: Buffer | string, msg: string): Buffer =>
			crypto.createHmac("sha256", key).update(msg).digest();
		let key: Buffer = hmac("AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830");
		for (const part of ["us-east-1", "iam", "aws4_request"]) key = hmac(key, part);
		const nul_key = hmac(Buffer.from([0, 0, 0, 107]), "msg").toString("hex");
		await run(
			"hmac_chained_keys",
			`
const k_date = Hmac.sha256("AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830")
const k_region = Hmac.sha256(k_date, "us-east-1")
const k_service = Hmac.sha256(k_region, "iam")
const k_signing = Hmac.sha256(k_service, "aws4_request")
Console.write_line(Hex.encode(k_signing))
Console.write_line(Hex.encode(Hmac.sha256("\\x00\\x00\\x00k", "msg")))
`,
			`${key.toString("hex")}\n${nul_key}\n`,
		);
	});

	test("incremental updates match, and finish re-arms the same key", async () => {
		await run(
			"hmac_incremental",
			`
var mac = Hmac("Jefe")
mac.update("what do ya ")
mac.update("want for nothing?")
Console.write_line(Hex.encode(mac.finish()))
mac.update("what do ya want for nothing?")
Console.write_line(Hex.encode(mac.finish()))
`,
			"5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843\n" +
				"5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843\n",
		);
	});
});
