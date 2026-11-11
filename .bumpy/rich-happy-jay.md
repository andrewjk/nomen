---
nomen-lang: minor
nomen: minor
---

GUI lifetime follows the macOS convention: the process stays alive after the last window closes (Window.keep_alive); Window.quit() quits the app, Window.close() closes one window; manual-loop apps call Window.keep_alive
