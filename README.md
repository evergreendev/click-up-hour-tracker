# ClickUp retainer sync

Dependency-free Node.js 22+ CLI. Runs once and exits. Contract data lives in ClickUp, not deployment configuration. Development and tests use mocks; no live writes have been made.

## Setup

1. Create a List named **Client Retainers**. Add the custom fields below to the List, and create a task template with Enabled unchecked. Each task represents exactly one contract period and is also its balance task.
2. Use an owner/admin API token with access to the entire client Folder tree and all relevant staff time. Ensure the authorized Workspace membership includes every staff member/guest whose time must count. The API cannot prove completeness for inaccessible Folders or former staff absent from membership; reconcile these before enabling a contract. Do not use a limited service account.
3. Copy `.env.example` to `.env` in the project folder and fill in the four values. The CLI automatically loads `.env` from the current working directory; existing environment variables take precedence. `RETAINER_STATE_PATH` is a persistent JSON file path, not a directory; relative paths resolve from the working directory. No extra packages are needed. There are no client-specific environment variables.
4. Run `node src/cli.js validate`, then `node src/cli.js dry-run --task TASK_ID`. Both calculate full totals and show resolved List names/IDs, local timezone, UTC boundaries, opening/ClickUp hours, remaining hours, first-run reached thresholds, and proposed comments. Neither writes ClickUp or local state.
5. Review the output, then run `node src/cli.js sync --apply`. Without `--apply`, sync is read-only. Schedule that same command hourly using cron or Windows Task Scheduler with the project working directory and the four settings available to the job. Exit code 1 indicates a contract/global error; other contracts still run when a contract fails. Output is JSON.

| Exact custom field name | ClickUp type / value |
| --- | --- |
| Enabled | Checkbox; check only after validation |
| Client Folder | Website; full Folder link |
| Contract start | Date, without a time, inclusive |
| Contract end | Date, without a time, inclusive |
| Hours allowance | Number, positive; required for fixed contract budgets |
| Monthly budget hours | Optional Number, positive; enables monthly carryover instead of Hours allowance |
| Current month budget hours | Number; required in monthly mode, managed by the sync |
| Hours remaining | Optional Number; managed by the sync, rounded to two decimals; negative means over budget |
| Budget remaining | Optional Progress (Manual); managed by the sync as the percentage of budget left |
| Timezone | Optional text; default `America/Denver`, IANA timezone |
| Alert thresholds | Optional text, comma-separated percentages; default `80,100` |
| AdOrbit opening hours | Optional number, nonnegative (including explicit zero) |
| Cutover date | Optional Date, without a time; required with opening hours |

Use Date fields without a time. The CLI decodes API timestamps in the authorized user timezone, then applies the contract timezone to the selected calendar dates. Existing ISO text dates remain supported. Folder links: `https://app.clickup.com/WORKSPACE/v/f/FOLDER` (also `/v/o/f/FOLDER`). List links: `/WORKSPACE/v/li/LIST` or `/WORKSPACE/v/l/6-LIST-VIEW`. Unrecognized/cross-workspace links fail validation rather than guessing.

The client Folder is the entire scope: the sync automatically includes every List in that Folder and its subfolders, including archived Lists. New Lists are discovered on every run. No List links or List allowlist field are needed for normal setup. Validation displays exactly what will count. An optional `List allowlist` Long Text field remains available for contracts that explicitly need a narrower scope; leave it unset to include the entire Folder.

To display a remaining-budget bar, add **Budget remaining** as a **Progress (Manual)** field on Client Retainers (a range of 0 to 100 is recommended). The next `sync --apply` fills it automatically alongside Hours remaining. It shows remaining hours divided by the contract allowance, or by the current month's carryover-adjusted budget in monthly mode. The percentage stays between 0% and 100%; zero or negative budgets show 0%. Hours remaining retains negative overages. Custom progress ranges are supported by scaling the percentage to that range. Dry-run shows `budgetRemainingPercent` and any `proposedProgressUpdate`, without writing. Missing optional fields are skipped; a Budget remaining field of the wrong type or with an invalid range fails validation before publishing. The [official Custom Fields documentation](https://developer.clickup.com/docs/customfields) specifies the manual progress payload as `{ "value": { "current": ... } }`.

Folder overview links such as `/WORKSPACE/v/db/VIEW-ID` are also accepted in Client Folder. The CLI resolves them using [Get View](https://developer.clickup.com/reference/getview) and requires the view's parent to be a Folder ([parent type 5](https://developer.clickup.com/docs/views)). It counts the entire Folder rather than the contents or filters of that view. No ClickUp field values are rewritten.

Add recipients in the balance task's **Followers** control (called watchers in the API). ClickUp comments notify followers and assignees; recipients can manage notification preferences in ClickUp. The CLI does not send email or maintain a separate recipient list.

## Onboarding and renewal

For a second client, create another registry task, set its Folder, dates and allowance, add followers, validate and enable it. No code or deployment changes.

For renewal, create a **new task** with the new period and allowance. Disable the expired task when you no longer want late entries recalculated, or leave it enabled to incorporate late corrections. Never recycle the old task for a new period: task IDs identify contracts and their alert history. Renaming a client preserves history. Avoid unintended overlapping periods over the same scope.

### UWBH rollout

Keep the existing UWBH retainer balance task. Move that task to Client Retainers using ClickUp's Move action (do not duplicate/recreate it); its task ID, description, comments and followers remain the contract identity. Add registry fields, title it UWBH, set 2026-01-01 through 2026-12-31 and **200 hours**, and link its client Folder. Leave List allowlist unset (clear it if previously populated). All Lists in the UWBH Folder and its subfolders count automatically, including ALICE, Outreach, Marketing, and Campaign. Review the resolved Lists in dry-run output.

Leave **both** AdOrbit opening hours and Cutover date unset until reconciliation. Until then the preview counts ClickUp time for all of 2026 and may not represent the complete historical balance. Keep Enabled unchecked while reconciling; `dry-run` previews all contracts, including disabled tasks; `--task TASK_ID` narrows the preview to one task. Enable it after reviewing reconciliation and before scheduling apply runs. After reconciliation, set both the opening total through the day before cutover and the cutover date (or leave both unset if ClickUp contains the complete period). Never enter a guessed opening balance. Review already-reached thresholds before the first apply. UWBH's settings are fixture/task data only; there is no UWBH branch in runtime code.

## Calculation and recovery

Completed time means nonnegative-duration time entries, independent of task status. Running timers are excluded. Entries are attributed by **start date** in the contract timezone; a midnight-spanning entry belongs wholly to its start day. No duration clipping. Opening hours replace pre-cutover ClickUp time. End dates include the whole local day, respecting DST. Each run refetches all period time across all discovered staff and resolved Lists, deduplicating entry IDs. Edits, backdating and deletions therefore affect the next total. Amounts retain full precision internally and display two decimals.

Only the `<!-- retainer-balance:start -->` through `<!-- retainer-balance:end -->` description block is managed. Other Markdown is preserved. A changed total updates the block and balance-change timestamp; unchanged totals do not update it. Malformed markers fail validation. Avoid editing the task description while a run is publishing: ClickUp provides no conditional description update.

First successful apply establishes a baseline and records reached thresholds without comments. Dry-run does not establish this baseline. Later newly reached thresholds are combined into one comment and fire once per task, even if corrections take usage below and then above a threshold. Threshold overrides use their numeric percentage as identity.

A durable pending alert is saved before posting; comments contain a deterministic marker. Retries read all comment pages to reconcile accepted posts before retrying. This recovers response timeouts and state-save failures. ClickUp has no documented idempotency key for comments: strict exactly-once delivery cannot be guaranteed if an accepted comment is not yet readable or someone deletes its marker. Keep marked comments intact and investigate ambiguous failures before scheduling retries if that risk is unacceptable. Balance writes are repeatable. Failed data reads publish neither balance nor alert state for that contract.

One apply process at a time is enforced by an exclusive `.lock` file adjacent to state. After a crash, confirm no job is running before removing that file. State writes use flush + atomic rename. Keep state on a local durable filesystem supporting atomic replacement; do not run independent schedulers against replicated copies. Missing state intentionally triggers first-run baselining; corrupted state aborts rather than resetting alerts. Back up state before rollout and after each renewal.

Time queries use 30-day windows and batches of up to 50 staff IDs per request. Requests are paced at least 650ms apart. On HTTP 429 the CLI waits for ClickUp's rate-limit reset or Retry-After header, then retries up to five times, printing wait messages to stderr. Other HTTP failures and exhausted retries fail that contract without publishing an incomplete balance. There is no documented pagination for the time-range endpoint; missing response arrays are errors. Access-denied resources or API omissions cannot be reconstructed locally. ClickUp documents its per-token limits and reset headers in [Rate Limits](https://developer.clickup.com/docs/rate-limits).

## Verified API references

Official ClickUp documentation checked 2026-11-16:

- [Get Tasks](https://developer.clickup.com/reference/gettasks): registry pagination, include closed tasks/subtasks.
- [Get Task](https://developer.clickup.com/reference/gettask) and [Update Task](https://developer.clickup.com/reference/updatetask): fetch/publish Markdown description.
- [Get Folder](https://developer.clickup.com/reference/getfolder): `include_subfolders=true` returns recursive `folders`; inaccessible subfolders are omitted. [Get Lists](https://developer.clickup.com/reference/getlists): active/archived Folder Lists.
- [Get Authorized Teams](https://developer.clickup.com/reference/getauthorizedteams): Workspace membership; [Get Authorized User](https://developer.clickup.com/reference/getauthorizeduser): authenticated identity. List-members endpoints only return explicit access and are insufficient for all-staff enumeration.
- [Time entries within date range](https://developer.clickup.com/reference/gettimeentrieswithinadaterange): explicit `assignee` required for other users, owner/admin permission, millisecond boundaries, one location filter, negative duration denotes running timer. No pagination parameters documented.
- [Get Task Comments](https://developer.clickup.com/reference/gettaskcomments): newest first, paginate with both `start` and `start_id`. [Create Task Comment](https://developer.clickup.com/reference/createtaskcomment): followers/watchers and assignees notified; `notify_all` also notifies author.

## Verification

`npm.cmd test` (Windows) or `npm test`; `npm.cmd run build` checks syntax. Tests use injected mock APIs, never a real token. Covers UWBH onboarding, adding a second client, renewal, nested/mixed Folder scope, migration pairs, DST, partial failure isolation, recalculation/deduplication, first-run suppression, rename stability, combined thresholds, retry reconciliation, read-only behavior and API pagination/write guard.


## ClickUp field types

Use **Date** Custom Fields for `Contract start`, `Contract end`, and `Cutover date`. Select a calendar date without adding a time. For UWBH select January 1, 2026 and December 31, 2026; leave Cutover date blank until reconciled. Existing ISO Text values remain supported for compatibility.

ClickUp returns date-only Custom Fields as 04:00 in the authorized API user's timezone ([official documentation](https://developer.clickup.com/docs/customfields)). The CLI reads that user's timezone automatically, recovers the selected calendar date, then applies the contract timezone to calculate inclusive start/end boundaries. No extra deployment setting is needed. A missing API-user timezone or a Date field with an explicit time is a validation error.

## Monthly budgets

Set **Monthly budget hours** on the registry task to the base hours granted each calendar month. Add a Number custom field named **Current month budget hours**; apply runs write the adjusted budget there using ClickUp's [Set Custom Field Value endpoint](https://developer.clickup.com/reference/setcustomfieldvalue). Keep the base field unchanged unless you intend to change the budget for the entire contract history.

For a 20-hour base, using 15 hours in January gives February 25 hours; using 25 hours gives February 15 hours. Carryover accumulates across all months since Contract start, including months with no time. Negative budgets remain negative so debt is preserved. The current month's time reduces the displayed remaining hours, not the budget field. Calendar months use the task timezone; partial first/last months receive the full base budget. Runs outside the contract period report an error and leave the task unchanged.

Every run rebuilds carryover from historical time, so retries do not compound it and late corrections update the balance. Opening migration hours count as aggregate usage before Cutover date; when cutover is in the current month, that aggregate counts in the current month's usage (earlier month allocation cannot be inferred). Alerts use the adjusted monthly budget and baseline again for each new month. Dry-run previews monthly values without writing. Existing tasks without Monthly budget hours retain fixed-period behavior. Keep scheduling sync to publish month changes; ClickUp does not calculate this itself.
