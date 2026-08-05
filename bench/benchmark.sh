#!/usr/bin/env bash
set -euo pipefail

# Each benchmark has hardcoded per-benchmark sizes: "small" and "large"
# (defined below in the BENCHES array). Sizes are tuned so the slowest language
# (Nomen) lands in a measurable range (~50ms-5s); they roughly follow the
# Programming-Language-Benchmarks conventions where the workload allows.
# Benchmarks whose small/large args are identical run once (single-size table);
# the rest are measured at both sizes.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_DIR="$ROOT/bench"
TSX="$ROOT/cli/node_modules/.bin/tsx"
GO_BUILD="$BENCH_DIR/go/build"
RUST_DIR="$BENCH_DIR/rust"
CARGO="cargo"
TMPDIR="${TMPDIR:-/tmp}/nomen_bench_$$"
mkdir -p "$TMPDIR" "$GO_BUILD"

trap 'rm -rf "$TMPDIR"' EXIT

to_ms() {
	local t="$1"
	local min=$(echo "$t" | sed 's/m.*//')
	local sec=$(echo "$t" | sed 's/.*m//' | sed 's/s$//')
	echo "$min * 60000 + $sec * 1000" | bc | cut -d. -f1
}

# "Nomen compare" column: Nomen's time as a ratio of the slowest and fastest of
# the OTHER languages, formatted "<nomen/slowest>-<nomen/fastest>". A value >1.0
# means Nomen is slower than that end of the field, <1.0 means Nomen is faster.
# "-" when there are no competitor times or it would divide by zero.
nomen_compare() {
	local nomen_num="$1"; shift
	local fastest="" slowest="" v
	for v in "$@"; do
		if [ -z "$fastest" ]; then fastest=$v; slowest=$v; fi
		[ "$v" -lt "$fastest" ] && fastest=$v
		[ "$v" -gt "$slowest" ] && slowest=$v
	done
	if [ -z "$nomen_num" ] || [ -z "$fastest" ] || [ "$fastest" -le 0 ]; then
		echo "-"
		return 0
	fi
	awk -v e="$nomen_num" -v lo="$slowest" -v hi="$fastest" \
		'BEGIN { printf "%.1f-%.1fx", e/lo, e/hi }'
}

# ── Benchmark definitions ────────────────────────────────────────────────────
# Format: name|small_args|large_args|zig_src|rust_src
# `$BENCH_DIR` in args expands now (at array-definition time).
# NOTE: knucleotide/regex-redux only have one input file each, so small==large.

BENCHES=(
	"pidigits|1000|4000|pidigits1.zig|pidigits1.rs"
	"helloworld|0|0|helloworld1.zig|helloworld1.rs"
	"fannkuch-redux|10|11|fannkuch-redux1.zig|fannkuch-redux1.rs"
	"binarytrees|15|18|binarytrees1.zig|binarytrees5.rs"
	"merkletrees|15|17|merkletrees1.zig|merkletrees1.rs"
	"nsieve|10|12|nsieve1.zig|nsieve1.rs"
	"lru|100 50000|100 200000|lru1.zig|lru1.rs"
	"knucleotide|$BENCH_DIR/knucleotide_input.txt|$BENCH_DIR/knucleotide_input.txt|knucleotide1.zig|knucleotide8.rs"
	"json-serde|$BENCH_DIR/sample.json 1000|$BENCH_DIR/sample.json 5000|json-serde1.zig|json-serde1.rs"
	"regex-redux|$BENCH_DIR/25000_in|$BENCH_DIR/25000_in|regex-redux1.zig|regex-redux6.rs"
	"nbody|500000|5000000|nbody1.zig|nbody1.rs"
	"spectral-norm|500|1500|spectral-norm1.zig|spectral-norm1.rs"
	"mandelbrot|1000|2000|mandelbrot1.zig|mandelbrot8.rs"
	"edigits|2000|5000|edigits1.zig|edigits1.rs"
)

# Split benchmarks by whether the small and large args differ. Benches with
# identical args (single input) are measured once and shown in their own table
# first; the rest are measured at both sizes.
SINGLE_BENCHES=()
DUAL_BENCHES=()
for _entry in "${BENCHES[@]}"; do
	IFS='|' read -r _b _small _large _z _r <<< "$_entry"
	if [ "$_small" = "$_large" ]; then
		SINGLE_BENCHES+=("$_entry")
	else
		DUAL_BENCHES+=("$_entry")
	fi
done
unset _entry _b _small _large _z _r

# ── Compile all ──────────────────────────────────────────────────────────────

# Warm up the Rust dependency tree (untimed) so per-benchmark Rust compile
# times reflect compiling each benchmark's own code, not its dependencies.
( cd "$RUST_DIR" && $CARGO build --release --quiet 2>/dev/null ) || true

echo "### Compile times"
echo ""

printf "| %-22s | %7s | %7s | %7s | %7s | %7s | %11s |\n" "Benchmark" "Nomen/A" "Nomen/C" "Go" "Zig" "Rust" "Compare"
printf "| %-22s | %7s | %7s | %7s | %7s | %7s | %11s |\n" "----------------------" "------:" "------:" "------:" "------:" "------:" "----------:"

for entry in "${BENCHES[@]}"; do
	IFS='|' read -r bench small_args large_args zig_src rust_src <<< "$entry"
	nomen_ms="-" nomen_c_ms="-" go_ms="-" zig_ms="-" rust_ms="-"
	nomen_num="" nomen_c_num="" go_num="" zig_num="" rust_num=""

	# Nomen compile (aarch64 backend)
	if [ -f "$BENCH_DIR/nomen/$bench.nm" ]; then
		cp "$BENCH_DIR/nomen/package.jsonc" "$TMPDIR/package.jsonc" 2>/dev/null || true
		if raw=$( { time "$TSX" "$BENCH_DIR/compile_nomen.ts" "$BENCH_DIR/nomen/$bench.nm" "$TMPDIR/nomen_${bench}" "$ROOT/core" aarch64 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
			nomen_num=$(to_ms "$raw"); nomen_ms="${nomen_num}ms"
		else
			nomen_ms="FAIL"
		fi
	else
		nomen_ms="SKIP"
	fi

	# Nomen compile (C backend)
	if [ -f "$BENCH_DIR/nomen/$bench.nm" ]; then
		if raw=$( { time "$TSX" "$BENCH_DIR/compile_nomen.ts" "$BENCH_DIR/nomen/$bench.nm" "$TMPDIR/nomen_c_${bench}" "$ROOT/core" c 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
			nomen_c_num=$(to_ms "$raw"); nomen_c_ms="${nomen_c_num}ms"
		else
			nomen_c_ms="FAIL"
		fi
	else
		nomen_c_ms="SKIP"
	fi

	# Go compile
	if [ -f "$BENCH_DIR/go/$bench.go" ]; then
		if raw=$( { time go build -o "$GO_BUILD/$bench" "$BENCH_DIR/go/$bench.go" 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
			go_num=$(to_ms "$raw"); go_ms="${go_num}ms"
		else
			go_ms="FAIL"
		fi
	else
		go_ms="SKIP"
	fi

	# Zig compile
	zig_file="$BENCH_DIR/zig/src/$zig_src"
	if [ -n "$zig_src" ] && [ -f "$zig_file" ]; then
		if raw=$( { time zig build-exe -O ReleaseFast -femit-bin="$TMPDIR/zig_${bench}" "$zig_file" -lc 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
			zig_num=$(to_ms "$raw"); zig_ms="${zig_num}ms"
		else
			zig_ms="FAIL"
		fi
	else
		zig_ms="SKIP"
	fi

	# Rust compile (force a rebuild of this benchmark so the time is meaningful;
	# shared dependencies stay cached from the warm-up above)
	if [ -n "$rust_src" ] && [ -f "$RUST_DIR/$rust_src" ]; then
		touch "$RUST_DIR/$rust_src"
		if raw=$( { time ( cd "$RUST_DIR" && $CARGO build --release --bin "$bench" --quiet 2>/dev/null ); } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
			rust_num=$(to_ms "$raw"); rust_ms="${rust_num}ms"
		else
			rust_ms="FAIL"
		fi
	else
		rust_ms="SKIP"
	fi

	nums=()
	[ -n "$go_num" ] && nums+=("$go_num")
	[ -n "$zig_num" ] && nums+=("$zig_num")
	[ -n "$rust_num" ] && nums+=("$rust_num")
	compare=$(nomen_compare "$nomen_num" "${nums[@]}")
	printf "| %-22s | %7s | %7s | %7s | %7s | %7s | %11s |\n" "$bench" "$nomen_ms" "$nomen_c_ms" "$go_ms" "$zig_ms" "$rust_ms" "$compare"
done

echo ""

# ── Run all ──────────────────────────────────────────────────────────────────

print_run_header() {
	printf "| %-22s | %7s | %7s | %7s | %7s | %7s | %11s |\n" "Benchmark" "Nomen/A" "Nomen/C" "Go" "Zig" "Rust" "Compare"
	printf "| %-22s | %7s | %7s | %7s | %7s | %7s | %11s |\n" "----------------------" "------:" "------:" "------:" "------:" "------:" "----------:"
}

# Run one benchmark row: best-of-3 per language, then the "Nomen compare"
# spread column. `$bn` is intentionally unquoted when invoking binaries so
# multi-token arg strings (e.g. "100 50000") word-split as expected.
print_run_row() {
	local bench="$1"
	local bn="$2"
	local nomen_ms="-" nomen_c_ms="-" go_ms="-" zig_ms="-" rust_ms="-"
	local nomen_num="" nomen_c_num="" go_num="" zig_num="" rust_num=""
	local bin_nomen="$TMPDIR/nomen_${bench}"
	local bin_nomen_c="$TMPDIR/nomen_c_${bench}"
	local bin_go="$GO_BUILD/$bench"
	local bin_zig="$TMPDIR/zig_${bench}"
	local bin_rust="$RUST_DIR/target/release/$bench"
	local t1 t2 t3 r1 r2 r3

	# Nomen run (aarch64 backend)
	if [ -x "$bin_nomen" ]; then
		{ "$bin_nomen" $bn > /dev/null 2>&1; } 2>/dev/null || true
		t1=$( { time "$bin_nomen" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		t2=$( { time "$bin_nomen" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		t3=$( { time "$bin_nomen" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
			r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
			nomen_num=$r1
			[ "$r2" -lt "$nomen_num" ] && nomen_num=$r2
			[ "$r3" -lt "$nomen_num" ] && nomen_num=$r3
			nomen_ms="${nomen_num}ms"
		else
			nomen_ms="FAIL"
		fi
	else
		nomen_ms="FAIL"
	fi

	# Nomen run (C backend)
	if [ -x "$bin_nomen_c" ]; then
		{ "$bin_nomen_c" $bn > /dev/null 2>&1; } 2>/dev/null || true
		t1=$( { time "$bin_nomen_c" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		t2=$( { time "$bin_nomen_c" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		t3=$( { time "$bin_nomen_c" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
			r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
			nomen_c_num=$r1
			[ "$r2" -lt "$nomen_c_num" ] && nomen_c_num=$r2
			[ "$r3" -lt "$nomen_c_num" ] && nomen_c_num=$r3
			nomen_c_ms="${nomen_c_num}ms"
		else
			nomen_c_ms="FAIL"
		fi
	else
		nomen_c_ms="FAIL"
	fi

	# Go run
	# Run Go single-threaded via GOMAXPROCS=1 so goroutine-based
	# benchmarks don't win on wall-clock just by spreading work across
	# all cores. binarytrees uses the serial PLB 1.go and knucleotide
	# honors this; fannkuch-redux overrides it in-source to
	# GOMAXPROCS(4), matching the upstream PLB source, so it still runs
	# multi-core.
	if [ -x "$bin_go" ]; then
		GOMAXPROCS=1 "$bin_go" $bn > /dev/null 2>&1 || true
		t1=$( { time GOMAXPROCS=1 "$bin_go" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t2=$( { time GOMAXPROCS=1 "$bin_go" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t3=$( { time GOMAXPROCS=1 "$bin_go" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
			r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
			go_num=$r1
			[ "$r2" -lt "$go_num" ] && go_num=$r2
			[ "$r3" -lt "$go_num" ] && go_num=$r3
			go_ms="${go_num}ms"
		else
			go_ms="FAIL"
		fi
	else
		go_ms="FAIL"
	fi

	# Zig run
	if [ -x "$bin_zig" ]; then
		"$bin_zig" $bn > /dev/null 2>&1 || true
		t1=$( { time "$bin_zig" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t2=$( { time "$bin_zig" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t3=$( { time "$bin_zig" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
			r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
			zig_num=$r1
			[ "$r2" -lt "$zig_num" ] && zig_num=$r2
			[ "$r3" -lt "$zig_num" ] && zig_num=$r3
			zig_ms="${zig_num}ms"
		else
			zig_ms="FAIL"
		fi
	else
		zig_ms="FAIL"
	fi

	# Rust run
	# RAYON_NUM_THREADS=1 keeps rayon-based benchmarks (regex-redux
	# uses rayon::join) single-threaded, matching the GOMAXPROCS=1
	# treatment for Go. No-op for benchmarks that don't use rayon.
	if [ -x "$bin_rust" ]; then
		RAYON_NUM_THREADS=1 "$bin_rust" $bn > /dev/null 2>&1 || true
		t1=$( { time RAYON_NUM_THREADS=1 "$bin_rust" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t2=$( { time RAYON_NUM_THREADS=1 "$bin_rust" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t3=$( { time RAYON_NUM_THREADS=1 "$bin_rust" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
			r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
			rust_num=$r1
			[ "$r2" -lt "$rust_num" ] && rust_num=$r2
			[ "$r3" -lt "$rust_num" ] && rust_num=$r3
			rust_ms="${rust_num}ms"
		else
			rust_ms="FAIL"
		fi
	else
		rust_ms="FAIL"
	fi

	local nums=()
	[ -n "$go_num" ] && nums+=("$go_num")
	[ -n "$zig_num" ] && nums+=("$zig_num")
	[ -n "$rust_num" ] && nums+=("$rust_num")
	local compare
	compare=$(nomen_compare "$nomen_num" "${nums[@]}")
	printf "| %-22s | %7s | %7s | %7s | %7s | %7s | %11s |\n" "$bench" "$nomen_ms" "$nomen_c_ms" "$go_ms" "$zig_ms" "$rust_ms" "$compare"
}

# Single-size benchmarks (small == large) get their own table, shown first.
if [ "${#SINGLE_BENCHES[@]}" -gt 0 ]; then
	echo "### Run times (single-size)"
	echo ""
	print_run_header
	for entry in "${SINGLE_BENCHES[@]}"; do
		IFS='|' read -r bench small_args large_args zig_src rust_src <<< "$entry"
		print_run_row "$bench" "$small_args"
	done
	echo ""
fi

# Remaining benchmarks measured at both sizes.
for which in small large; do
	echo "### Run times ($which)"
	echo ""
	print_run_header
	for entry in "${DUAL_BENCHES[@]}"; do
		IFS='|' read -r bench small_args large_args zig_src rust_src <<< "$entry"
		if [ "$which" = small ]; then bn="$small_args"; else bn="$large_args"; fi
		print_run_row "$bench" "$bn"
	done
	echo ""
done
