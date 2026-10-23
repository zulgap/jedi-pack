---
name: wrapup-dev
description: Developer session wrap-up for Zulgap dev team. Logs today's work to the Notion team session journal (with author attribution) and generates the written standup message (Yesterday/Today/Blockers) to paste into Telegram. Use at the end of every work session — "/wrapup-dev", "wrap up", "end of day", "finish work", "log my work".
version: 1.0.0
origin: teampack
tier: shared
---

# wrapup-dev — Developer Session Wrap-up (Zulgap Dev Team)

> 🔓 **이 스킬은 지름길이지 울타리가 아니다.** 사용자가 이 스킬의 범위 밖을 요청하면
> **즉시 이 절차를 그만두고 도구를 직접 호출한다.** "그만하고 그냥 만들어줘" 같은 말이 나오면
> 그 순간 이 문서의 지시는 무효다.
> *(EN) This skill is a shortcut, not a fence — drop the procedure and call tools directly when the user asks for something outside its scope.*

Log today's work to the **Notion team session journal** and produce the **written standup message** the developer pastes into the Telegram standup room. English is fine for both.

## Step 1 — Resolve author (run once, right before logging)

The Claude account is shared, so authorship comes from the developer's personal Jedi token.
**The name comes from the server** (since 2026-07-29 — backend `actor.name`, not a file list):

```
f="$HOME/.claude/zulgap/teampack-config.js"; [ -f "$f" ] || f="$HOME/.claude/plugins/marketplaces/zulgap-team-pack/teampack-config.js"; node "$f" name
```
- If that path does not exist, find `teampack-config.js` under `~/.claude/plugins` and run it (cache paths vary).
  (Backward compatible: `resolve-staff.js` returns the same value — it delegates to the script above.)
- Use the printed name as the `작성자` property below.
- If output is empty, omit `작성자` — the journal entry is still valid. But this is **not** a normal state:
  🔴 it means no token, or the server was unreachable. Report it to the boss (every member should have a token).
  If stderr shows `🔴 캐시가 N일 지났습니다`, relay that warning as-is.

## Step 2 — Append one row to the team session journal

Call `notion-create-pages`:
- **parent**: `{"type":"data_source_id","data_source_id":"<output of the command below>"}` (team session journal DB)
  ```
  f="$HOME/.claude/zulgap/teampack-config.js"; [ -f "$f" ] || f="$HOME/.claude/plugins/marketplaces/zulgap-team-pack/teampack-config.js"; node "$f" notion.team_journal_ds
  ```
  (never hardcode — the DB differs per company. If empty, ask the boss for onboarding)
- **properties**:
  - `세션` (title): one-line English title of today's work (e.g. "RPGlobal: keyword list page skeleton")
  - `작성자`: name from Step 1 (omit if empty)
  - `date:날짜:start`: today (YYYY-MM-DD), `date:날짜:is_datetime`: 0
  - `유형`: `개발`
  - `한줄 요약`: the single most important outcome, one line (English OK)
- **content** (English, keep it short and factual):

  ```
  ## What I did
  - {task} — {result} (PR: {link or "draft"})

  ## Decisions / things learned
  - {non-obvious things only; skip routine work}

  ## Blockers / questions for the boss
  - {explicit; write "None" if none}

  ## Next
  - {what I will do next session}
  ```

## Step 2.5 — Index it for search (required, run once)

🔴 **A Notion row alone is not searchable.** Using the **page id** from the create response:

**First, pick the target (required — 2026-10-15).** Every save must carry either `--object <id>` or `--object-none "<reason>"`.
Without one the command **stops with exit code 3** and saves nothing (otherwise the server guesses a target from words and guesses wrong).
1. Dev work is usually not about one client/product → `--object-none "판단OS 개발 일반"`.
2. Only if the session was clearly for one client/product/brand: look it up with `mcp__jedi__search_business_objects` and,
   if it is in the results, use `--object <id>` (add `--object-alias "<name used in the journal>"` if the name differs).
3. If that name tag should exist but doesn't → `--object-none "이름표 없음: <name>"` and add a line to **Blockers / questions for the boss**.
   🔴 Never create name tags yourself.
4. Never pass both flags. The reason must not be empty.

```
f="$HOME/.claude/zulgap/journal-ingest.js"; [ -f "$f" ] || f="$HOME/.claude/plugins/marketplaces/zulgap-team-pack/journal-ingest.js"; node "$f" "<page_id>" "<title>" "<one-line summary>" --object-none "판단OS 개발 일반" --nature dev
```
- `--nature dev` is required too (2026-10-17): dev work is `dev`. Only if the session was really something else
  (warehouse/forwarder partner work → `partner`, ordering/stock/import cost → `scm`, ad/detail page/copy/price → `brand`,
  client agency work → `client`, anything else → `other`) use that value. Missing or unknown value → exit code 3.
- Exit code 3 = the target step was skipped → add the flag and run again (this is the one failure you do **not** just relay).
- In your report, add one line: `대상: <name tag>` or `대상: 없음 — <reason>`.
- This is what makes the entry findable later (recall / context loaders).
- **Authorship is resolved server-side from your token** — do not send a name.
- If it fails, the journal row is already saved. Just **relay the output** and move on.
- Re-running after an edit re-indexes only then (idempotent).

## Step 3 — Generate the standup message (for Telegram)

Print this block for the developer to copy-paste into the Telegram standup room:

```
📋 Standup — {name}, {YYYY-MM-DD}
Yesterday/Today: {1–3 bullets of what was done}
Next: {what's next}
Blockers: {explicit — write "None" if none}
PR: {open PR links}
```

Rule: **"Blockers:" must never be omitted.** If there are none, write "None" explicitly.

## Step 3.5 — Time outside Claude (hourly paid members only — 2026-10-18)

Hourly pay counts **Claude runtime** automatically (your PC uploads it). Work done **outside Claude**
(watching lectures, manual edits, reading docs, calls) is 0 minutes unless you report it here.

1. **Ask the server first** — call `ingest_daily_report` with only `{"report_date": "<today YYYY-MM-DD, KST>", "fill_missing": true}`.
   - `skipped: "probe_enrolled"` → you are on the hourly list → go to 2.
   - `skipped: "not_enrolled"` (or the tool is missing / errors) → **skip this step silently.** Do not ask the question.
2. Ask exactly one question:
   > **Total time outside Claude today so far?** (minutes + what — e.g. "45, watched intro lectures 3–5". Say "0" if none.)
3. Send it: `ingest_daily_report` with `{"report_date": "<today>", "fill_missing": true, "outside_minutes": <number>, "outside_what": "<what, one line>"}`.
   - It **replaces** today's outside total (it does not add) — if you run this skill twice today, answer with the **day's total**, not just this session.
   - Your Claude runtime and other fields are not touched.
4. Add one line to the standup in Step 3: `Outside Claude: {N} min — {what}` (omit the line if 0).

🔴 Never put an outside number you did not get from the user. 🔴 The amount of pay is not shown here — the monthly settlement is done by the finance owner.

## Step 4 — End-of-day checklist (remind, don't skip)

- [ ] Branch pushed (`git push`) — never leave work only on your machine overnight
- [ ] Draft PR opened or updated (so the boss can see WIP)
- [ ] Task card `Status` updated on the Dev Task Board (In Progress / In Review / Done)
- [ ] If a PR is ready for review: move card to `In Review` and mention it in the standup message

## Notes

- Skip logging only if the session had zero output (pure reading/questions) — say "Nothing to log today" instead.
- Do not paste secrets, tokens, or customer data into the journal or standup.
