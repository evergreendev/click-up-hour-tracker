# ClickUp retainer sync

Dependency-free Node.js 22+ CLI. Runs once and exits. Contract data lives in ClickUp, not deployment configuration. Development and tests use mocks; no live writes have been made.

## Setup

1. Create a List named **Client Retainers**. Add the custom fields below to the List, and create a task template with Enabled unchecked. Each task represents exactly one contract period and is also its balance task.
2. Use an owner/admin API token with access to the entire client Folder tree and all relevant staff time. Ensure the authorized Workspace membership includes every staff member/guest whose time must count. The API cannot prove completeness for inaccessible Folders or former staff absent from membership; reconcile these before enabling a contract. Do not use a limited service account.
3. Set only these deployment values: `CLICKUP_WORKSPACE_ID`, `CLICKUP_REGISTRY_LIST_ID`, `CLICKUP_API_TOKEN`, `RETAINER_STATE_PATH` (absolute path to a persistent JSON file, not a directory). Protect the token and state; back up state. There are no client-specific environment variables.
4. Run `node src/cli.js validate`, then `node src/cli.js dry-run --task TASK_ID`. Both calculate full totals and show resolved List names/IDs, local timezone, UTC boundaries, opening/ClickUp hours, remaining hours, first-run reached thresholds, and proposed comments. Neither writes ClickUp or local state.
5. Review the output, then run `node src/cli.js sync --apply`. Without `--apply`, sync is read-only. Schedule that same command hourly using cron or Windows Task Scheduler with the project working directory and the four settings available to the job. Exit code 1 indicates a contract/global error; other contracts still run when a contract fails. Output is JSON.

| Exact custom field name | ClickUp type / value |
| --- | --- |
| Enabled | Checkbox; check only after validation |
| Client Folder | Website; full Folder link |
| Contract start | Text, `YYYY-MM-DD`, inclusive |
| Contract end | Text, `YYYY-MM-DD`, inclusive |
| Hours allowance | Number, positive |
| Timezone | Optional text; default `America/Denver`, IANA timezone |
| Alert thresholds | Optional text, comma-separated percentages; default `80,100` |
| List allowlist | Optional long text, List links separated by whitespace or commas |
| AdOrbit opening hours | Optional number, nonnegative (including explicit zero) |
| Cutover date | Optional text, `YYYY-MM-DD`; required with opening hours |

Use text dates to avoid ClickUp date-field timezone conversions. Numeric API date values are also accepted as UTC calendar dates. Folder links: `https://app.clickup.com/WORKSPACE/v/f/FOLDER` (also `/v/o/f/FOLDER`). List links: `/WORKSPACE/v/li/LIST` or `/WORKSPACE/v/l/6-LIST-VIEW`. Unrecognized/cross-workspace links fail validation rather than guessing.

Default scope is every List in the linked Folder and nested subfolders, including archived Lists. An allowlist narrows that scope; every selected List must belong to the Folder tree. There is no implicit name/tag rule for “service” Lists: use the allowlist when any Folder work is outside the contract. Validation displays exactly what will count.

Add recipients in the balance task's **Followers** control (called watchers in the API). ClickUp comments notify followers and assignees; recipients can manage notification preferences in ClickUp. The CLI does not send email or maintain a separate recipient list.

## Onboarding and renewal

For a second client, create another registry task, set its Folder, dates and allowance, add followers, validate and enable it. No code or deployment changes.

For renewal, create a **new task** with the new period and allowance. Disable the expired task when you no longer want late entries recalculated, or leave it enabled to incorporate late corrections. Never recycle the old task for a new period: task IDs identify contracts and their alert history. Renaming a client preserves history. Avoid unintended overlapping periods over the same scope.

### UWBH rollout

Keep the existing UWBH retainer balance task. Move that task to Client Retainers using ClickUp's Move action (do not duplicate/recreate it); its task ID, description, comments and followers remain the contract identity. Add registry fields, title it UWBH, set 2026-01-01 through 2026-12-31 and **200 hours**, and link its client Folder. Paste the actual List links for **ALICE, Outreach, Marketing, Campaign** into List allowlist, excluding other Folder work. Verify the four resolved names/IDs in dry-run output.

Leave **both** AdOrbit opening hours and Cutover date unset until reconciliation. Until then the preview counts ClickUp time for all of 2026 and may not represent the complete historical balance. Keep Enabled unchecked while reconciling; `dry-run --task TASK_ID` also previews a disabled task. Enable it after reviewing reconciliation and before scheduling apply runs. After reconciliation, set both the opening total through the day before cutover and the cutover date (or leave both unset if ClickUp contains the complete period). Never enter a guessed opening balance. Review already-reached thresholds before the first apply. UWBH's settings are fixture/task data only; there is no UWBH branch in runtime code.

## Calculation and recovery

Completed time means nonnegative-duration time entries, independent of task status. Running timers are excluded. Entries are attributed by **start date** in the contract timezone; a midnight-spanning entry belongs wholly to its start day. No duration clipping. Opening hours replace pre-cutover ClickUp time. End dates include the whole local day, respecting DST. Each run refetches all period time across all discovered staff and resolved Lists, deduplicating entry IDs. Edits, backdating and deletions therefore affect the next total. Amounts retain full precision internally and display two decimals.

Only the `<!-- retainer-balance:start -->` through `<!-- retainer-balance:end -->` description block is managed. Other Markdown is preserved. A changed total updates the block and balance-change timestamp; unchanged totals do not update it. Malformed markers fail validation. Avoid editing the task description while a run is publishing: ClickUp provides no conditional description update.

First successful apply establishes a baseline and records reached thresholds without comments. Dry-run does not establish this baseline. Later newly reached thresholds are combined into one comment and fire once per task, even if corrections take usage below and then above a threshold. Threshold overrides use their numeric percentage as identity.

A durable pending alert is saved before posting; comments contain a deterministic marker. Retries read all comment pages to reconcile accepted posts before retrying. This recovers response timeouts and state-save failures. ClickUp has no documented idempotency key for comments: strict exactly-once delivery cannot be guaranteed if an accepted comment is not yet readable or someone deletes its marker. Keep marked comments intact and investigate ambiguous failures before scheduling retries if that risk is unacceptable. Balance writes are repeatable. Failed data reads publish neither balance nor alert state for that contract.

One apply process at a time is enforced by an exclusive `.lock` file adjacent to state. After a crash, confirm no job is running before removing that file. State writes use flush + atomic rename. Keep state on a local durable filesystem supporting atomic replacement; do not run independent schedulers against replicated copies. Missing state intentionally triggers first-run baselining; corrupted state aborts rather than resetting alerts. Back up state before rollout and after each renewal.

Time queries are split by staff and UTC day to bound request sizes. There is no documented pagination for the time-range endpoint; the CLI does not infer undocumented limits or silently accept missing response arrays. Large contracts can take time and hit rate limits; HTTP errors (including 429) fail that contract for retry on a later run. Access-denied resources or API omissions cannot be reconstructed locally.

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

