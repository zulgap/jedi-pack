---
name: start-dev
description: Developer session starter for Zulgap dev team. Loads your assigned tasks from the Notion Dev Task Board and reminds you of the workflow rules. Use at the start of every work session — "/start-dev", "start work", "what should I work on", "good morning", "let's begin".
version: 1.0.0
origin: teampack
tier: shared
---

# start-dev — Developer Session Start (Zulgap Dev Team)

> 🔓 **이 스킬은 지름길이지 울타리가 아니다.** 사용자가 이 스킬의 범위 밖을 요청하면
> **즉시 이 절차를 그만두고 도구를 직접 호출한다.** "그만하고 그냥 만들어줘" 같은 말이 나오면
> 그 순간 이 문서의 지시는 무효다.
> *(EN) This skill is a shortcut, not a fence — drop the procedure and call tools directly when the user asks for something outside its scope.*

Load the developer's assigned tasks from the **Notion Dev Task Board** and present a clear "today's plan", plus a short reminder of the workflow rules. English-first (the codebase has Korean comments — translate/explain them for the developer whenever needed).

## Dev Task Board (SSOT for "what to do")

- Data source ID (for queries) — **never hardcode**, get it from the server:
  ```
  node "$HOME/.claude/plugins/marketplaces/zulgap-team-pack/teampack-config.js" notion.dev_task_board_ds
  ```
  Then query `collection://<that id>`. If empty, ask the boss for onboarding.
- Columns: `Task` (title) / `Status` (Backlog·Todo·In Progress·In Review·Done) / `Priority` (P1·P2·P3) / `Service` / `Assignee` / `PR Link` / `Due`
- Card body = background + **Acceptance Criteria checklist** (written by the boss). The card is the single source of what "done" means.

## Steps

1. **Fetch active tasks** — query the data source for rows where `Status` is `Todo` or `In Progress` or `In Review` (use `notion-query-data-sources` with the collection URL above; fall back to `notion-fetch` on the database page if querying fails).
2. **(Optional) GitHub state** — if the `gh` CLI is available and authenticated, also run `gh pr list --author @me --state open` and `gh issue list --assignee @me` in the current repo to show open PRs/issues.
3. **Output today's plan** in this format:

   ```
   🌏 Dev Task Board loaded

   ▶ In Progress (finish these first)
   - {Task} [{Priority}] {Service} — {PR Link if any}

   ▶ In Review (respond to review comments)
   - {Task} — {PR Link}

   ▶ Todo (next up, highest priority first)
   1. {Task} [{Priority}] {Service}

   📌 Suggested focus today: {1 task — In Progress first, then highest-priority Todo}
   ```

4. **Rules reminder** (print every session, short form):
   - Rebase your branch on the latest `main`/`master` **now** (start of day): `git fetch origin && git rebase origin/<default-branch>`
   - One task = one branch = one small PR. Branch lives **max 2 days**.
   - Open a **Draft PR early** so everyone can see what files you are touching.
   - Korean UI text comes **only from the task card** — never invent Korean copy yourself.
   - Never touch production infra, secrets, or DB migrations. When in doubt, ask in the standup room.

5. **Blocker check** — ask: "Any blockers from yesterday? If something is unclear about a task card, ask the boss now (in the Telegram standup room), not after hours of guessing."

## Notes

- If the Notion board is empty or unreachable, say so and suggest asking the boss for today's assignment. Do not invent tasks.
- This skill is read-mostly: you may move a card's `Status` (e.g. Todo → In Progress) when the developer says they are starting it, but never edit the card's Acceptance Criteria (boss-owned).
- At the end of the day, use `/wrapup-dev` to log the session and generate the standup report.
