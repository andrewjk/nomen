const std = @import("std");

const global_allocator = std.heap.c_allocator;

fn nsieve(n: usize) !void {
    var count: usize = 0;
    var flags = try global_allocator.alloc(bool, n);
    @memset(flags, false);
    defer global_allocator.free(flags);
    var i: usize = 2;
    while (i < n) : (i += 1) {
        if (!flags[i]) {
            count += 1;
            var j: usize = i << 1;
            while (j < n) : (j += i) {
                flags[j] = true;
            }
        }
    }
    var buf: [128]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "Primes up to {d:8} {d:8}\n", .{ n, count }) catch unreachable;
    _ = std.c.write(1, msg.ptr, msg.len);
}

pub fn main(init: std.process.Init) !void {
    const n = try getN(init);
    var i: u6 = 0;
    while (i < 3) : (i += 1) {
        const base: usize = 10000;
        try nsieve(base << (n - i));
    }
}

fn getN(init: std.process.Init) !u6 {
    var arg_iter = try std.process.Args.iterateAllocator(init.minimal.args, init.gpa);
    defer arg_iter.deinit();
    _ = arg_iter.skip();
    const arg = arg_iter.next() orelse return 4;
    return try std.fmt.parseInt(u6, arg, 10);
}
