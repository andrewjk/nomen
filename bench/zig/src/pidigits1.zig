const std = @import("std");
const bigint = std.math.big.int;
const global_allocator = std.heap.c_allocator;

pub fn main(init: std.process.Init) !void {
    const n = try getN(init);
    var out_buf: [128]u8 = undefined;

    const one = (try bigint.Managed.initSet(global_allocator, 1));
    const two = (try bigint.Managed.initSet(global_allocator, 2));
    const ten = (try bigint.Managed.initSet(global_allocator, 10));

    var k = try bigint.Managed.initSet(global_allocator, 1);
    var n1 = try bigint.Managed.initSet(global_allocator, 4);
    var n2 = try bigint.Managed.initSet(global_allocator, 3);
    var d = try bigint.Managed.initSet(global_allocator, 1);
    var tmp = try bigint.Managed.init(global_allocator);
    var tmp2 = try bigint.Managed.init(global_allocator);
    var v = try bigint.Managed.init(global_allocator);
    var u = try bigint.Managed.init(global_allocator);
    var w = try bigint.Managed.init(global_allocator);

    var digits_printed: usize = 0;
    var lbuf: [10]std.math.big.Limb = undefined;
    var sb: [10]u8 = undefined;
    while (true) {
        try bigint.Managed.divFloor(&u, &tmp, &n1, &d);
        try bigint.Managed.divFloor(&v, &tmp, &n2, &d);
        if (bigint.Managed.eql(u, v)) {
            const rem = @rem(digits_printed, 10);
            _ = u.toConst().toString(sb[rem..], 10, .lower, &lbuf);
            digits_printed += 1;
            if (rem == 9) {
                const msg = std.fmt.bufPrint(&out_buf, "{s}\t:{d}\n", .{ sb, digits_printed }) catch unreachable;
                _ = std.c.write(1, msg.ptr, msg.len);
            }

            if (digits_printed >= n) {
                if (rem != 9) {
                    @memset(sb[rem + 1 ..], ' ');
                    const msg = std.fmt.bufPrint(&out_buf, "{s}\t:{d}\n", .{ sb, digits_printed }) catch unreachable;
                    _ = std.c.write(1, msg.ptr, msg.len);
                }
                break;
            }
            try bigint.Managed.mul(&tmp, &u, &d);
            try bigint.Managed.mul(&tmp2, &tmp, &ten);
            try bigint.Managed.mul(&tmp, &n1, &ten);
            try bigint.Managed.sub(&n1, &tmp, &tmp2);
            try bigint.Managed.mul(&tmp, &n2, &ten);
            try bigint.Managed.sub(&n2, &tmp, &tmp2);
        } else {
            try bigint.Managed.mul(&tmp2, &k, &two);
            try bigint.Managed.sub(&tmp, &tmp2, &one);
            try bigint.Managed.mul(&u, &tmp, &n1);
            try bigint.Managed.mul(&v, &n2, &two);
            try bigint.Managed.sub(&tmp, &k, &one);
            try bigint.Managed.mul(&w, &tmp, &n1);
            try bigint.Managed.add(&n1, &u, &v);
            try bigint.Managed.add(&tmp, &k, &two);
            try bigint.Managed.mul(&u, &tmp, &n2);
            try bigint.Managed.add(&n2, &w, &u);
            try bigint.Managed.add(&tmp, &tmp2, &one);
            try bigint.Managed.mul(&d, &tmp, &d);
            try bigint.Managed.add(&k, &k, &one);
        }
    }
}

fn getN(init: std.process.Init) !i32 {
    var arg_iter = try std.process.Args.iterateAllocator(init.minimal.args, init.gpa);
    defer arg_iter.deinit();
    _ = arg_iter.skip();
    const arg = arg_iter.next() orelse return 1;
    return try std.fmt.parseInt(i32, arg, 10);
}
