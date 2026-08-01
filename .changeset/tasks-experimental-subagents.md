---
"eve": patch
---

Add experimental background tasks for subagents. With `experimental.tasks` on the root agent, subagent calls return a task receipt immediately instead of blocking the turn, and the model manages the delegated work with the new `task_peek`, `task_await`, `task_cancel`, `task_send`, and `task_sleep` tools. Terminal results and input requests wake the parent through the normal session delivery path. Without the flag, nothing changes.
