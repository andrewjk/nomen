import add_error from "../add_error.ts";
import RawNode from "../nodes/RawNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";

export default function parse_raw(status: ParseStatus) {
	const start = get_index(status);
	accept("raw", status);
	// Lockdown: raw `#arch:` blocks are the library's own escape hatch —
	// they splice arbitrary C/asm into the translation unit, which subsumes
	// everything `unsafe` offers. Reserved for the System library source
	// (the compiler's own machinery tests opt out via `allow_user_raw`).
	if (!status.allow_user_raw && !is_library_region(status, start)) {
		add_error(
			status,
			`'raw' blocks are reserved for the System library — inline architecture code is not available to user code`,
			start,
		);
	}
	/*
  if (expect("{", status)) {
    let value: string[] = [];
    let depth = 0;
    while (true) {
      if (accept("{", status)) {
        depth += 1;
      } else if (accept("}", status)) {
        if (depth === 0) {
          break;
        } else {
          depth -= 1;
        }
      }
      value.push(consume(status));
    }

    const raw = new RawNode(start, value.join(" "));
    add_to_parent(raw, "Raw C", status);
  }
    */

	const value = consume(status).trim().replaceAll(/^\s+/gm, "");
	const raw = new RawNode(start, value);
	add_to_parent(raw, "Raw C", status);
}

/** Same boundary rule as `unsafe`: only the appended System library source
 *  (source offsets at or past the user source's end) may use raw blocks. */
function is_library_region(status: ParseStatus, offset: number): boolean {
	return status.unsafe_boundary !== undefined && offset >= status.unsafe_boundary;
}
