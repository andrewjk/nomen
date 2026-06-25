// regex-redux benchmark — mirrors the Go version: read a FASTA file, strip
// headers and newlines, count 9 DNA regex variants, apply 5 substitution
// patterns, and print the results.
//
// Build: zig build-exe -O ReleaseFast regex-redux1.zig
// Usage: regex-redux <filename>

const std = @import("std");
const mvzr = @import("mvzr.zig");

pub fn main(init: std.process.Init) !void {
	const io = init.io;
	const gpa = init.gpa;
	const arena = init.arena.allocator();

	var out_buffer: [4096]u8 = undefined;
	var stdout = std.Io.File.stdout().writer(io, &out_buffer);

	const args = try std.process.Args.toSlice(init.minimal.args, arena);
	const path: []const u8 = if (args.len > 1) args[1] else "25000_in";

	const cwd = std.Io.Dir.cwd();
	const text = try cwd.readFileAlloc(io, path, gpa, .unlimited);
	defer gpa.free(text);

	const original_len = text.len;

	// Clean: remove FASTA headers (>...) and all newlines.
	var cleaned = try replaceAll(gpa, "(>[^\n]+)?\n", text, "");
	defer gpa.free(cleaned);
	const cleaned_len = cleaned.len;

	// Count variants.
	const variants = [_][]const u8{
		"agggtaaa|tttaccct",
		"[cgt]gggtaaa|tttaccc[acg]",
		"a[act]ggtaaa|tttacc[agt]t",
		"ag[act]gtaaa|tttac[agt]ct",
		"agg[act]taaa|ttta[agt]cct",
		"aggg[acg]aaa|ttt[cgt]ccct",
		"agggt[cgt]aa|tt[acg]accct",
		"agggta[cgt]a|t[acg]taccct",
		"agggtaa[cgt]|[acg]ttaccct",
	};
	for (variants) |v| {
		try stdout.interface.print("{s} {d}\n", .{ v, countMatches(v, cleaned) });
	}

	// Substitutions.
	try applySub(gpa, &cleaned, "tHa[Nt]", "<4>");
	try applySub(gpa, &cleaned, "aND|caN|Ha[DS]|WaS", "<3>");
	try applySub(gpa, &cleaned, "a[NSt]|BY", "<2>");
	try applySub(gpa, &cleaned, "<[^>]*>", "|");
	try applySub(gpa, &cleaned, "\\|[^|][^|]*\\|", "-");

	try stdout.interface.print("\n{d}\n{d}\n{d}\n", .{ original_len, cleaned_len, cleaned.len });
	try stdout.interface.flush();
}

fn countMatches(pattern: []const u8, haystack: []const u8) usize {
	const re = mvzr.compile(pattern) orelse return 0;
	var it = re.iterator(haystack);
	var n: usize = 0;
	while (it.next()) |_| n += 1;
	return n;
}

fn replaceAll(gpa: std.mem.Allocator, pattern: []const u8, haystack: []const u8, replacement: []const u8) ![]u8 {
	var result: std.ArrayList(u8) = .empty;
	errdefer result.deinit(gpa);
	const re = mvzr.compile(pattern) orelse {
		try result.appendSlice(gpa, haystack);
		return result.toOwnedSlice(gpa);
	};
	var it = re.iterator(haystack);
	var pos: usize = 0;
	while (it.next()) |m| {
		try result.appendSlice(gpa, haystack[pos..m.start]);
		try result.appendSlice(gpa, replacement);
		pos = m.end;
	}
	try result.appendSlice(gpa, haystack[pos..]);
	return result.toOwnedSlice(gpa);
}

fn applySub(gpa: std.mem.Allocator, dst: *[]u8, pattern: []const u8, replacement: []const u8) !void {
	const next = try replaceAll(gpa, pattern, dst.*, replacement);
	gpa.free(dst.*);
	dst.* = next;
}
