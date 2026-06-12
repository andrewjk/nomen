#!/usr/bin/env bash
set -euo pipefail

N=${1:-500}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_DIR="$ROOT/bench"
TSX="$ROOT/bin/node_modules/.bin/tsx"
TMPDIR="${TMPDIR:-/tmp}/pidigits_bench_$$"
mkdir -p "$TMPDIR"

trap 'rm -rf "$TMPDIR"' EXIT

# Convert "0m0.231s" to milliseconds
to_ms() {
    local t="$1"
    local min=$(echo "$t" | sed 's/m.*//')
    local sec=$(echo "$t" | sed 's/.*m//' | sed 's/s$//')
    echo "$min * 60000 + $sec * 1000" | bc | cut -d. -f1
}

echo "=== pidigits benchmark (n=$N) ==="
echo ""

# ── Echo ──────────────────────────────────────────────────────────────────────
echo "Building Echo pidigits (n=$N)..."

sed "s/var int n = 200/var int n = $N/" "$BENCH_DIR/echo/pidigits.echo" > "$TMPDIR/pidigits_echo_$N.echo"
cp "$BENCH_DIR/echo/package.jsonc" "$TMPDIR/package.jsonc"

"$TSX" "$BENCH_DIR/compile_echo.ts" "$TMPDIR/pidigits_echo_$N.echo" "$TMPDIR/echo_pidigits" "$ROOT/lib" 2>"$TMPDIR/echo_compile_err.txt"
if [ $? -ne 0 ]; then
    echo "FAIL: Echo compilation failed"
    cat "$TMPDIR/echo_compile_err.txt"
    exit 1
fi

{ time "$TMPDIR/echo_pidigits" > "$TMPDIR/echo_out.txt" 2>&1; } 2>"$TMPDIR/echo_time.txt"
ECHO_REAL=$(grep real "$TMPDIR/echo_time.txt" | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//')
ECHO_MS=$(to_ms "$ECHO_REAL")
cat "$TMPDIR/echo_out.txt"
echo ""
echo "Echo time: ${ECHO_MS}ms"
echo ""

# ── Zig ───────────────────────────────────────────────────────────────────────
echo "Building Zig pidigits (n=$N)..."

cd "$BENCH_DIR/zig"
zig build -Doptimize=ReleaseFast 2>"$TMPDIR/zig_compile_err.txt" || {
    echo "FAIL: Zig compilation failed"
    cat "$TMPDIR/zig_compile_err.txt"
    exit 1
}

{ time "$BENCH_DIR/zig/zig-out/bin/zig" "$N" > "$TMPDIR/zig_out.txt" 2>&1; } 2>"$TMPDIR/zig_time.txt"
ZIG_REAL=$(grep real "$TMPDIR/zig_time.txt" | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//')
ZIG_MS=$(to_ms "$ZIG_REAL")
cat "$TMPDIR/zig_out.txt"
echo ""
echo "Zig time:  ${ZIG_MS}ms"
echo ""

# ── Go ────────────────────────────────────────────────────────────────────────
echo "Building Go pidigits (n=$N)..."

mkdir -p "$BENCH_DIR/go/build"
go build -o "$BENCH_DIR/go/build/pidigits" "$BENCH_DIR/go/pidigits.go" 2>"$TMPDIR/go_compile_err.txt" || {
    echo "FAIL: Go compilation failed"
    cat "$TMPDIR/go_compile_err.txt"
    exit 1
}

{ time "$BENCH_DIR/go/build/pidigits" "$N" > "$TMPDIR/go_out.txt" 2>&1; } 2>"$TMPDIR/go_time.txt"
GO_REAL=$(grep real "$TMPDIR/go_time.txt" | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//')
GO_MS=$(to_ms "$GO_REAL")
cat "$TMPDIR/go_out.txt"
echo ""
echo "Go time:   ${GO_MS}ms"
echo ""

# ── Correctness ───────────────────────────────────────────────────────────────
echo "=== Correctness ==="
echo ""

# Extract digits from each output
ECHO_DIGITS=$(sed 's/[[:space:]].*//' "$TMPDIR/echo_out.txt" | tr -d '\n')
ZIG_DIGITS=$(cut -c1-10 "$TMPDIR/zig_out.txt" | tr -d '\n')
GO_DIGITS=$(cut -c1-10 "$TMPDIR/go_out.txt" | tr -d '\n')

check_digits() {
    local name="$1"
    local digits="$2"
    local len=${#digits}

    if [ "$len" -ne "$N" ]; then
        echo "$name: FAIL (expected $N digits, got $len)"
        return 1
    fi

    if [ "${digits:0:1}" != "3" ]; then
        echo "$name: FAIL (first digit is ${digits:0:1}, expected 3)"
        return 1
    fi

    echo "$name: digit count OK ($len), first digit OK"
    return 0
}

check_digits "Echo" "$ECHO_DIGITS" && ECHO_OK=1 || ECHO_OK=0
check_digits "Zig"  "$ZIG_DIGITS"  && ZIG_OK=1  || ZIG_OK=0
check_digits "Go"   "$GO_DIGITS"   && GO_OK=1   || GO_OK=0

echo ""

# Compare all three
ALL_MATCH=1
if [ "$ECHO_DIGITS" != "$ZIG_DIGITS" ]; then
    ALL_MATCH=0
fi
if [ "$ECHO_DIGITS" != "$GO_DIGITS" ]; then
    ALL_MATCH=0
fi

if [ "$ALL_MATCH" -eq 1 ]; then
    echo "All outputs MATCH"
else
    echo "Outputs DIFFER"
    show_diff() {
        local name1="$1" d1="$2" name2="$3" d2="$4"
        local max=${#d1}
        if [ ${#d2} -gt "$max" ]; then max=${#d2}; fi
        for i in $(seq 0 $((max - 1))); do
            if [ "${d1:$i:1}" != "${d2:$i:1}" ]; then
                echo "  $name1 vs $name2: first diff at digit $((i+1)): '${d1:$i:1}' vs '${d2:$i:1}'"
                return
            fi
        done
    }
    [ "$ECHO_DIGITS" = "$ZIG_DIGITS" ] || show_diff "Echo" "$ECHO_DIGITS" "Zig"  "$ZIG_DIGITS"
    [ "$ECHO_DIGITS" = "$GO_DIGITS"  ] || show_diff "Echo" "$ECHO_DIGITS" "Go"   "$GO_DIGITS"
    [ "$ZIG_DIGITS"  = "$GO_DIGITS"  ] || show_diff "Zig"  "$ZIG_DIGITS"  "Go"   "$GO_DIGITS"
fi

echo ""
echo "=== Summary ==="
printf "  %-6s  %8s  %s\n" "Lang" "Time" "Status"
printf "  %-6s  %7sms  %s\n" "Echo" "$ECHO_MS" "$([ $ECHO_OK -eq 1 ] && echo 'OK' || echo 'FAIL')"
printf "  %-6s  %7sms  %s\n" "Zig"  "$ZIG_MS"  "$([ $ZIG_OK  -eq 1 ] && echo 'OK' || echo 'FAIL')"
printf "  %-6s  %7sms  %s\n" "Go"   "$GO_MS"   "$([ $GO_OK   -eq 1 ] && echo 'OK' || echo 'FAIL')"
