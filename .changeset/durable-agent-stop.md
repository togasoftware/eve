---
"eve": minor
---

`useEveAgent().stop()` now safely cancels the active durable turn and keeps consuming events through its cancellation boundary. Framework lifecycle cleanup still detaches locally without cancelling server work.
