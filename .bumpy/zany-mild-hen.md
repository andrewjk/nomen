---
nomen-lang: minor
---

Add the async I/O netpoller (kqueue/epoll) with __nomen_io_wait parking fibers on socket readiness, and a non-blocking Tcp stdlib (listen/accept/connect/send/recv/recv_all/close); concurrent-connection scale validation and the Http port are still pending
