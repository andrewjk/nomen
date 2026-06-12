const std = @import("std");

var buffer: [1024]u8 = undefined;
var fixed_allocator = std.heap.FixedBufferAllocator.init(buffer[0..]);
var allocator = fixed_allocator.allocator();

pub fn main(init: std.process.Init) !void {
    const n = try getN(init);

    var perm = try allocator.alloc(usize, n);
    var perm1 = try allocator.alloc(usize, n);
    var count = try allocator.alloc(usize, n);

    var max_flips_count: usize = 0;
    var perm_count: usize = 0;
    var checksum: isize = 0;

    for (perm1, 0..) |*e, i| {
        e.* = i;
    }

    var r = n;
    var buf: [256]u8 = undefined;
    loop: {
        while (true) {
            while (r != 1) : (r -= 1) {
                count[r - 1] = r;
            }

            for (perm, 0..) |_, i| {
                perm[i] = perm1[i];
            }

            var flips_count: usize = 0;

            while (true) {
                const k = perm[0];
                if (k == 0) {
                    break;
                }

                const k2 = (k + 1) >> 1;
                var i: usize = 0;
                while (i < k2) : (i += 1) {
                    std.mem.swap(usize, &perm[i], &perm[k - i]);
                }
                flips_count += 1;
            }

            max_flips_count = @max(max_flips_count, flips_count);
            if (perm_count % 2 == 0) {
                checksum += @intCast(flips_count);
            } else {
                checksum -= @intCast(flips_count);
            }

            while (true) : (r += 1) {
                if (r == n) {
                    break :loop;
                }

                const perm0 = perm1[0];
                var i: usize = 0;
                while (i < r) {
                    const j = i + 1;
                    perm1[i] = perm1[j];
                    i = j;
                }

                perm1[r] = perm0;
                count[r] -= 1;

                if (count[r] > 0) {
                    break;
                }
            }

            perm_count += 1;
        }
    }

    const msg = std.fmt.bufPrint(&buf, "{d}\nPfannkuchen({d}) = {d}\n", .{ checksum, n, max_flips_count }) catch unreachable;
    _ = std.c.write(1, msg.ptr, msg.len);
}

fn getN(init: std.process.Init) !usize {
    var arg_iter = try std.process.Args.iterateAllocator(init.minimal.args, init.gpa);
    defer arg_iter.deinit();
    _ = arg_iter.skip();
    const arg = arg_iter.next() orelse return 10;
    return try std.fmt.parseInt(usize, arg, 10);
}
