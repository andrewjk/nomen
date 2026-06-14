const std = @import("std");
const md5 = std.crypto.hash.Md5;

const VEC_SIZE = 8;
const Vec = @Vector(VEC_SIZE, f64);

const global_allocator = std.heap.c_allocator;

pub fn main(init: std.process.Init) !void {
    const n = try get_n(init);
    const size = (n + VEC_SIZE - 1) / VEC_SIZE * VEC_SIZE;
    const chunk_size = size / VEC_SIZE;
    const inv = 2.0 / @as(f64, @floatFromInt(size));
    const xloc = try global_allocator.alloc(Vec, chunk_size);
    var i: usize = 0;
    while (i < chunk_size) : (i += 1) {
        const offset = i * VEC_SIZE;
        xloc[i] = Vec{
            init_xloc(offset, inv),
            init_xloc(offset + 1, inv),
            init_xloc(offset + 2, inv),
            init_xloc(offset + 3, inv),
            init_xloc(offset + 4, inv),
            init_xloc(offset + 5, inv),
            init_xloc(offset + 6, inv),
            init_xloc(offset + 7, inv),
        };
    }

    var buf: [128]u8 = undefined;
    const header = std.fmt.bufPrint(&buf, "P4\n{d} {d}\n", .{ size, size }) catch unreachable;
    _ = std.c.write(1, header.ptr, header.len);

    const pixels = try global_allocator.alloc(u8, size * chunk_size);
    var y: usize = 0;
    while (y < size) : (y += 1) {
        const ci = @as(f64, @floatFromInt(y)) * inv - 1.0;
        var x: usize = 0;
        while (x < chunk_size) : (x += 1) {
            pixels[y * chunk_size + x] = mbrot8(xloc[x], ci);
        }
    }

    var hash: [16]u8 = undefined;
    md5.hash(pixels, &hash, .{});
    var hexbuf: [33]u8 = undefined;
    const hexchars = "0123456789abcdef";
    var hi: usize = 0;
    while (hi < 16) : (hi += 1) {
        hexbuf[hi * 2] = hexchars[hash[hi] >> 4];
        hexbuf[hi * 2 + 1] = hexchars[hash[hi] & 0xf];
    }
    hexbuf[32] = '\n';
    _ = std.c.write(1, &hexbuf, 33);
}

fn mbrot8(cr: Vec, civ: f64) u8 {
    const ci = @as(Vec, @splat(civ));
    const zero: f64 = 0.0;
    var zr = @as(Vec, @splat(zero));
    var zi = @as(Vec, @splat(zero));
    var tr = @as(Vec, @splat(zero));
    var ti = @as(Vec, @splat(zero));
    var absz = @as(Vec, @splat(zero));

    var _i: u8 = 0;
    while (_i < 10) : (_i += 1) {
        var _j: u8 = 0;
        while (_j < 5) : (_j += 1) {
            zi = (zr + zr) * zi + ci;
            zr = tr - ti + cr;
            tr = zr * zr;
            ti = zi * zi;
        }
        absz = tr + ti;
        const absz_arr: [VEC_SIZE]f64 = @bitCast(absz);
        var terminate = true;
        var i: u8 = 0;
        while (i < VEC_SIZE) : (i += 1) {
            if (absz_arr[i] <= 4.0) {
                terminate = false;
                break;
            }
        }
        if (terminate) {
            return 0;
        }
    }
    var accu: u8 = 0;
    const absz_arr2: [VEC_SIZE]f64 = @bitCast(absz);
    var i: u8 = 0;
    while (i < VEC_SIZE) : (i += 1) {
        if (absz_arr2[i] <= 4.0) {
            const lhs: u8 = 0x80;
            accu |= (lhs >> @as(u3, @intCast(i)));
        }
    }
    return accu;
}

fn init_xloc(i: usize, inv: f64) f64 {
    return @as(f64, @floatFromInt(i)) * inv - 1.5;
}

fn get_n(init: std.process.Init) !usize {
    var arg_iter = try std.process.Args.iterateAllocator(init.minimal.args, init.gpa);
    defer arg_iter.deinit();
    _ = arg_iter.skip();
    const arg = arg_iter.next() orelse return 200;
    return try std.fmt.parseInt(usize, arg, 10);
}
