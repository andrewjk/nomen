const std = @import("std");
const Io = std.Io;
const zbench = @import("zbench");
const pidigits_mod = @import("pidigits.zig");

const PidigitsBench = struct {
    n: usize,

    pub fn run(self: *const PidigitsBench, allocator: std.mem.Allocator) void {
        pidigits_mod.pidigits(self.n, allocator) catch unreachable;
    }
};

fn parseArgs(init: std.process.Init) !usize {
    const arena: std.mem.Allocator = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);

    if (args.len > 1) {
        return try std.fmt.parseInt(usize, args[1], 10);
    }
    return 4000;
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena: std.mem.Allocator = init.arena.allocator();

    const n = try parseArgs(init);

    const bench_ctx = PidigitsBench{ .n = n };
    const bench_name = try std.fmt.allocPrint(arena, "pidigits_{d}", .{n});

    var bench = zbench.Benchmark.init(std.heap.page_allocator, .{});
    defer bench.deinit();

    try bench.addParam(bench_name, &bench_ctx, .{});

    try bench.run(io, .stdout());
}
