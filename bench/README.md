# Nomen Benchmark Suite

## Converted Benchmarks

These benchmarks have been converted to Nomen and are included in `benchmark.sh`.

| Benchmark      | Nomen | Go  | Zig | Notes                                                                   |
| -------------- | ---- | --- | --- | ----------------------------------------------------------------------- |
| pidigits       | ✅   | ✅  | ✅  | BigInt digit computation                                                |
| helloworld     | ✅   | ✅  | -   | Trivial startup test                                                    |
| fannkuch-redux | ✅   | ✅  | -   | Permutation/flip counting (single-threaded)                             |
| binarytrees    | ✅   | ✅  | -   | Recursive tree allocation using classes                                 |
| merkletrees    | ✅   | ✅  | -   | Merkle tree hash computation using classes                              |
| nsieve         | ✅   | -   | -   | Sieve of Eratosthenes using Buffer (Go needs external `bitset` package) |
| lru            | ✅   | ✅  | -   | LRU cache using Map and Buffer for access order tracking                |
| knucleotide    | ✅   | ✅  | -   | DNA k-mer frequency counting using File I/O, Buffer, and bit-packing    |
| json-serde     | ✅   | ✅  | ✅  | GeoJSON parse + serialize via `Json.parse`/`Json.stringify` (see note)  |
| regex-redux    | ✅   | ✅  | -   | FASTA sequence regex counting and substitution                          |

> **Note (json-serde):** the Nomen version parses the GeoJSON document into a
> `JsonNode` tree and re-serializes it, like the Go/Zig versions. It does **not**
> md5-hash the output (Nomen has no MD5 in the standard library yet); instead it
> prints the serialized length as a verifiable checksum. The input is the
> hard-coded `bench/sample.json`.

## Not Converted

The remaining Go benchmarks require language features or standard library support that Nomen does not currently have.

### Needs floating-point arrays and/or math functions

| Benchmark         | What's needed                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mandelbrot**    | Float64 arrays for pixel data, MD5 hash for output verification. Core computation is just float arithmetic in a loop.                                                  |
| **nbody**         | Float struct fields work, but needs `sqrt()` (could use inline C). No float arrays needed — uses structs. Feasible with a small inline C sqrt helper.                  |
| **spectral-norm** | Float64 arrays for vector math, `sqrt()` for final result. Would need a Buffer-based float array abstraction or inline C helpers.                                      |
| **edigits**       | BigInt operations work, but the stopping criterion uses `math.Log`, `math.Pi`, and `math.Ln10`. Would need inline C for these floating-point math constants/functions. |

### Needs random number generation

| Benchmark | What's needed                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fasta** | A simple LCG random number generator (the Go version implements its own). Also needs buffered string output. The concurrent Go version would need to be simplified to single-threaded. Feasible with inline C for the RNG. |

### Needs concurrency primitives

| Benchmark            | What's needed                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **coro-prime-sieve** | Goroutines and channels for the daisy-chain prime sieve. Would require a completely different single-threaded algorithm (e.g., trial division).                                                                                                                                                       |
| **binarytrees (Go)** | The Go version is the single-threaded PLB `1.go` (the parallel `2.go` would use `sync.WaitGroup` and goroutines across all cores, giving Go an unfair wall-clock advantage over the single-threaded Nomen/Rust/Zig versions). The Nomen version is also single-threaded and produces identical results. |

### Needs hash maps (partially done)

| Benchmark | What's needed                                                                                                        | Status  |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| **lru**   | Hash map (`map[K]V`) and doubly-linked list (`container/list`). Would need a custom hash map implementation in Nomen. | ✅ Done |

### Needs file I/O

_No remaining benchmarks need only file I/O._

### Needs regex engine

_No remaining benchmarks need only a regex engine._

### Needs external libraries

| Benchmark       | What's needed                                                   |
| --------------- | --------------------------------------------------------------- |
| **secp256k1**   | CGO bindings to `libsecp256k1` for elliptic curve cryptography. |
| **http-server** | HTTP server (`fasthttp`) and client (`net/http`) libraries.     |

## Easiest to Convert Next

In order of feasibility:

1. **nbody** — Only needs `sqrt()` via a small inline C helper. Struct-based float math works already.
2. **fasta** — Needs a simple LCG RNG (inline C). Single-threaded version is straightforward.
3. **edigits** — Needs `log()` and math constants (inline C). BigInt already works.
4. **mandelbrot** — Needs float64 array access pattern (could reuse Buffer with reinterpret casts).
5. **spectral-norm** — Same float array need as mandelbrot, plus sqrt.
