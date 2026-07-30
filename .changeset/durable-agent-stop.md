---
"eve": minor
---

`useEveAgent().stop()` now requests best-effort durable cancellation of the active turn and keeps streaming until the server settles instead of only detaching locally. Framework lifecycle cleanup still detaches local transport without cancelling server work.
