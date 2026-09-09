---
nomen-lang: minor
---

Add a `strict` enum modifier: values of a strict enum (core `Result`) can no longer be silently discarded in statement position — bind (`var _ = f.close()`) or match deliberately. Also fixes latent aarch64 pair-store range bugs the new discard locals exposed.
