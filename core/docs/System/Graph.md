# Graph

## `struct Graph<T>`

A graph of values connected by edges

**Members:**

- `add_node(T value)`
- `add_edge(int from, int to)`
- `edges_of(int node) -> int`
- `edge_target(int e) -> int`
- `next_edge(int e) -> int`
- `first() -> T`
- `at(int idx) -> T`
- `node_length() -> int`
- `edge_length() -> int`
