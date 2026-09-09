---
nomen-lang: minor
---

Convert Http to the error-enum pattern: Http.get/post now return Result<string, HttpError> (new core/System/Stream/HttpError.nm) instead of a plain string with a 0 status sentinel
