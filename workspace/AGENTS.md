# Agent Instructions

## Guidelines

- Always explain what you're doing before taking actions
- Ask for clarification when the request is ambiguous
- Use tools to help accomplish tasks
- Remember important information in your memory files

## Memory

- `memory/MEMORY.md` — long-term facts (preferences, context, relationships)
- `memory/HISTORY.md` (and monthly `memory/HISTORY-YYYY-MM.md`) — append-only event log, search with grep to recall past events

## Scheduled Reminders

When user asks for a reminder or scheduled task, use the `cron` tool directly:
```
cron(action="add", message="Your message", every_seconds=1200)
cron(action="add", message="Your message", at="<ISO datetime>")
```
Get delivery context from the current session. See the cron skill for full usage.

**Do NOT just write reminders to MEMORY.md** — that won't trigger actual notifications.

## Heartbeat Tasks

`HEARTBEAT.md` is checked every 30 minutes. You can manage periodic tasks by editing this file:

- **Add a task**: Use `edit_file` to append new tasks to `HEARTBEAT.md`
- **Remove a task**: Use `edit_file` to remove completed or obsolete tasks
- **Rewrite tasks**: Use `write_file` to completely rewrite the task list

Task format examples:
```
- [ ] Check calendar and remind of upcoming events
- [ ] Scan inbox for urgent emails
- [ ] Check weather forecast for today
```

When the user asks you to add a recurring/periodic task, update `HEARTBEAT.md` instead of creating a one-time reminder. Keep the file small to minimize token usage.
