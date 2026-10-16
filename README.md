# claude-mods

Claude Code mods (function-hook plugins) I find helpful. Each folder is one plugin.

Requires a Claude Code build with function-hook plugins (2.1.289 or newer). machine-guard reads macOS tools (`sysctl`, `vm_stat`, `ioreg`, `ps`).

```bash
git clone https://github.com/joeldg/claude-mods ~/Projects/claude-mods
```

## dev-servers

A pane of your project's running dev servers, so you don't have to ask Claude to restart them — and a tool so Claude doesn't have to run `lsof` to find out what's listening.

- `/servers` opens the **Servers** pane:
  - running servers whose working folder is in this repo: name, port, pid and uptime, with **Restart**, **Stop** and **Log**
  - known start commands that aren't running, with **Start**: `package.json` `dev`/`start`/`serve`/`preview` scripts (run with your lockfile's package manager), `.claude/launch.json` and `Procfile`
  - a count of other listeners on the machine. Claude Code's own sessions (the desktop app's engine and the `claude` CLI, which also listen on localhost from the project's folder) are never listed as servers nor counted as other listeners.
- Only button presses start or stop anything:
  - **Start** runs the command detached, logging to `~/.claude/dev-servers/<project>/`.
  - **Stop** sends SIGTERM. If the server ignores it, pressing again within 10s force-stops it.
  - **Restart** stops the server, waits for the port to free up, then starts it.
  - Before any signal, it checks the pid still runs the same command.
- Claude gets a read-only `dev_servers` tool: this project's running servers (name, port, pid, uptime, and the log when it was started from the pane), the start commands that aren't running, and with `all: true` every other listener on the machine (port, process), ending with how many Claude Code sessions it left out, e.g. `(7 Claude Code sessions not listed)`, so nothing is hidden silently. Its description tells Claude to use it instead of `lsof`/`netstat`/`ps`. It never starts or stops anything.
- When a command fails with "address already in use", Claude gets a note (and you a toast) naming the holder, e.g. `Port 4000 is held by node (pid 123, up 2h, in /Users/me/other)`.
- Status line: `servers: :4000 :5173`.
- Makes no model calls. The port scan is `netstat -anv -p tcp` (macOS) or `ss -ltnp` (Linux), never a bare `lsof`; `ps` and `lsof -d cwd` run once per new pid, one pid at a time. One open session scans per interval (15s by default) and writes `~/.claude/dev-servers/scan-cache.json` for the others; a slow scan doubles the interval, up to 5 minutes.

## downloads-drop

Puts files you just downloaded into your prompt with one click.

- Watches `~/Downloads` (top level). When a new file arrives (PDF, Markdown, images, 3MF/STL/OBJ, zip, video…), a band appears above the prompt: `New in Downloads: paper.pdf, model-b.3mf · 2m ago [Attach] [Dismiss]`.
- **Attach** puts `@"/Users/you/Downloads/paper.pdf"` mentions in your prompt. **Dismiss** hides those files.
- Waits until a file has finished downloading (skips partial downloads and files still growing), and ignores hidden and zero-byte files.
- `/downloads` lists the 10 newest files, numbered. `/downloads attach 1 3` (or `2-4`) adds those, and `/downloads clear` dismisses everything new.
- Stacks with other mods' bands (repo-brief, standing-orders, secret-guard) instead of hiding them.
- Makes no model calls.

Settings: `folder` (`~/Downloads`), `extensions`, `pollSeconds` (5), `maxAgeMinutes` (120).

## effort-router

Sets effort per message, so you don't have to switch it by hand.

- **Git chores** ("merged", "#219 merged", "commit and push", "push it", "open a PR", "close the issue") run at **low** effort and come back faster.
- **Deep asks** (audit, review, plan, design, investigate, root cause, "why does…", "figure out") run at **max**.
- **Everything else**, including approvals like "yes", "go ahead" and "continue" and anything that starts new work ("merged 219, go ahead with #214"), keeps your session's own effort.
- **Prompt cache:** changing effort makes the whole conversation get cached again. So it never switches mid-turn, raises effort at once, and over a large, warm cache lowers it only after 2 routine turns in a row. In small contexts, or once the cache has lapsed, it switches right away.
- **Budget cap:** reads usage-meter's machine-wide summary of the last 5 hours (`~/.claude/usage-meter/summary.json`, at most every 30 s) and, once `pct` reaches `budgetCapAt` (80%), caps every turn at `budgetCapEffort` (high), deep asks included, so you stop hitting the 5-hour wall. A turn already at or below the cap is left alone; lowering over a warm cache waits like any other lowering and never happens mid-turn. A missing or stale summary (over 10 minutes old), or one written before a limit was ever hit, is no budget information. The debug log gets one line when the cap engages and one when it releases. `budgetCapAt: 0` turns it off.
- **Subagents:** set `subagentEffort` (empty by default) to run every subagent request at that effort; the budget cap applies to them too (the lower of the two). Each subagent turn's effort is decided at its first request and kept for the turn.
- **Model guard:** set `avoidModel` (a regex such as `fable`) to send those requests to `fallbackModel` instead, subagents included.
- `/route` shows the last decision, the session's counts, the budget state (percent used, the cap, whether it is engaged) and the subagent effort. `/route off` and `/route on` toggle it all; `/route deep` and `/route routine` force the next turn.
- Status line while a turn is routed: `effort: low (routine)`; while the budget cap lowers it: `effort: high (budget 84%)`.
- Makes no model calls.

Settings: `routineEffort` (low), `deepEffort` (max), `routinePattern`, `deepPattern`, `avoidModel`, `fallbackModel` (opus), `stickyTurns` (2), `freeSwitchTokens` (30000), `cacheTtlMinutes` (60), `budgetCapAt` (80; 0 = off), `budgetCapEffort` (high), `subagentEffort` (empty = the session's own).

## job-watch

A **Jobs** pane for long-running work: training runs, downloads, extractions — and three tools so Claude follows them instead of polling.

- Picks up background Bash tasks and detached `nohup … > log &` launches by itself.
- `/watch <log> [label]` adds any other log file.
- Shows progress, ETA and the last log line, and flags a job as stalled when its log goes quiet; a background task's exit code is read from the end of its output.
- Shows free space on `/` and `/Volumes/*` (the NAS).
- Toasts when a job finishes or stalls. The status line shows `jobs: 2 running · 1 stalled`. A timer Claude sets for itself — `sleep 600 && echo done`, a loop of sleeps, or a task described as a wait, timer, pause or delay that only polls and reports with read-only programs (`rg`, `tail`, `pgrep`…) — is still listed by `jobs_list` and shown as a dim `timer` row, but never toasts, never counts in the status line, does not open the pane, is judged by its exit marker alone (no `ps`), and leaves a minute after it ends. Anything that runs a real program is a job, however it is described.
- `/jobs` opens the pane, `/unwatch <label|id|done|all>` removes jobs.
- Tools for Claude: `jobs_list` (every watched job's state, pid, progress, ETA, last-output age, exit code and log path), `jobs_watch` (`{ pid?, log?, name?, quietMinutes? }`: follow a process or log started elsewhere; it never starts commands) and `jobs_unwatch` (`{ name }`). The first message of each conversation says jobs are watched and names them, so Claude stops writing `until … sleep` loops and running `ps`. They need no permission prompt: they only read the mod's own list.
- Makes no model calls: it reads logs with `tail`, checks processes with `ps` (one listing, or a per-pid lookup when only pids are watched), and runs `df`. A probe that times out or takes over 2 s is retried at a doubling interval, up to 5 minutes, until it is fast again. The debug log names a probe's pace only once it has held for two probes in a row, and at most once per five minutes per probe, so a pace that flips with the Mac's load leaves no trail.

Settings (in `/config`): stall minutes (10), refresh seconds (10), how long finished jobs stay (120 min; a timer leaves after a minute), auto-open (on), which disks to show.

## machine-guard

Memory, swap and GPU on the status line, a `machine_status` tool for Claude, and a guard that refuses heavy local jobs when the Mac can't take them.

- Status line: `RAM tight 12% free · swap 7.9/8G · top python 31G · GPU 87%`, and `CPU 4/16 cores` whenever macOS has parked the performance cores. "Free" is unused memory (vm_stat's free + inactive + speculative pages): what a new job can take without pushing anyone out. macOS's own "memory free percentage" counts active pages too, which is how a Mac can be "55% free" with the swap nearly full.
- It reads the kernel's counters only (two `sysctl` calls and `vm_stat`), every 15 s by default; the GPU (`ioreg`) on every third sample, never right after a slow one. One session samples and writes `~/.claude/machine-guard/sample.json` (with a `lock.json` while it probes); every other session shows the same numbers instead of probing too. When probes are slow or time out (10–40 s while the Mac swaps) on two samples in a row, the interval doubles, and doubles again with each further slow sample, up to 2 min; a single slow sample is a blip and changes nothing. The configured pace returns once two samples in a row are fast again. The other sessions follow the sampler's pace, so a blip stays quiet in every session.
- **Parked cores:** every sample also reads `kern.sched_recommended_cores`, the bitmask of CPUs the scheduler may use. When macOS's performance controller parks the performance cores (after a thermal event, or stuck until a sleep/wake or reboot), the status line shows `CPU 4/16 cores`, `machine_status` and `/guard` report it with the parked count, you get one toast once at least half the cores have been parked for a minute, or any parking has lasted five minutes (masks blip for seconds under GPU load), and one when they come back, and Claude gets a note when it starts heavy work so it keeps worker counts small. The guard never blocks on it.
- The process table (`ps`, the slowest probe) is taken only on demand (`/guard`, `machine_status`) or when a sample shows pressure, at most once a minute; "biggest" means the apps from a table taken in the last 5 minutes.
- It refuses heavy jobs (training, inference, rendering, extraction, Blender, Docker, ffmpeg) when:
  - macOS reports **critical** memory pressure (kernel level 4, or under 10% free with the swap 95% full), or
  - the Mac is **reserved** with `/busy`.

  When memory is only tight (under 20% free, or kernel level 2), the job runs and Claude gets a note to start one heavy job at a time.
- `machine_status` is a tool Claude can call (no input, allowed without asking): the sample's age, RAM free, swap, GPU, the pressure level, the biggest apps (or how to get a table), the guard's verdict and its rules. Claude is told to use it instead of `ps`, `top`, `vm_stat`, `memory_pressure` or project scripts before launching heavy work.
- `/busy 3h training a vision model` reserves the Mac in **every** Claude session. `/busy off` lifts it. The reservation lives in `~/.claude/machine-guard.json`, so a training script can write it too:
  ```bash
  echo '{"reason":"overnight training","until":'$(( ($(date +%s) + 8*3600) * 1000 ))'}' > ~/.claude/machine-guard.json
  ```
- `/guard` shows what it sees (and takes a process table when one is due). `/guard pause 15m` lets heavy jobs through in this session; `/guard on` resumes the guard.
- Remote runs (`modal run`, `ssh`), tests (`pytest`) and installs are never treated as heavy.
- Add your own heavy commands with the "Also heavy" setting (a regex), e.g. `overnight_|nightly_run\.sh`.

## mod-monitor

Watches how the other mods behave in real use, without changing them. It is listed first in `CLAUDE_CODE_PLUGIN_DIRS`, so the other mods' hooks run beneath it.

- **Failures:** any mod hook that throws, times out or rejects, read from the hook chain's results (`next.trace`), with the mod's name, the event and how long it ran. Slow hooks (over 1.5 s) are recorded too. The first failure of each mod in a session raises a toast.
- **What each mod did:** its toasts ("#219 merged → …", "Blocked: …"), status-line changes, the mod commands you used (never their arguments), and failed subprocesses (a burst of 5 in 10 minutes raises a toast). Git checks run outside a repository, and `rg`, `grep`, `pgrep` or `pkill` exiting 1 with nothing on stderr (no match, no such process), are logged as expected (`proc-expected`, with why), not as failures; an exit of 2 or more, or anything on stderr, still counts. It also records model calls (the only usage the mods cost: `/second-opinion`, `/recall ask`) and file writes (folders only, never contents).
- **`/mods`:** a pane with one row per mod: ✓ active, ⚠ failing, ✗ not seen this session, · seen but idle. Each row shows today's counts and last activity, with **Details** for its recent events. It also says which mods it can't see, if any of them run above it.
- **`/mods report [24h|7d|30d]`:** a per-mod report across all sessions, also written to `~/.claude/mods/monitor/report-latest.md` for a scheduled review or Claude to read.
- **`/mods failures [7d]`:** failures and failed subprocesses only.
- **Logs:** `~/.claude/mods/monitor/<date>/<session>.jsonl`, flushed every minute and at session end, with secrets masked and old days removed after 30 days.
- Makes no model calls and adds no measurable latency.
- **Error lines mods log themselves** (`$.ui.log` with wording like "failed" or "could not"): shown in Details and in `/mods failures`. Three in an hour mark the mod ⚠ and raise one toast. That is how effort-router's per-request hook, which runs inside the response stream where no monitor should sit, reports a failure. It also always sends the request on unchanged.
- **Transcript-row hooks** (secret-guard masks `/secrets` records there) are watched for failures and slow runs, but not counted per run.

Settings: `alerts` (on), `slowMs` (1500), `watchRender` (on), `watchCommands` (on; off stops "mod-monitor" appearing beside other mods' command output), `watchAppend` (on), `retentionDays` (30), `flushSeconds` (60).

## modal-meter

Keeps an eye on Modal so idle GPU containers don't burn credits — in the projects that use Modal, with one CLI run per minute for the whole machine.

- Watches a project only when it uses Modal: a `.py` file with `import modal` / `from modal import …` (one `rg` run, 5 s at most), or `modal` named in `pyproject.toml`, `requirements*.txt`, `uv.lock` or `poetry.lock`. The answer is remembered per project for a day. Running `/modal`, or any `modal …` command in Bash, switches it on for the session; `alwaysPoll` (off) watches every project.
- One session polls for all of them: whoever holds `~/.claude/modal-meter/lock.json` runs `modal app list --json` every `pollSeconds` (60) and writes `cache.json`; the other open sessions read the cache and refresh their own status line and pane from it. Once one session learns the CLI has no `billing report`, none tries it again for a day.
- Backs off while Modal is slow: an `app list` over 2 s or a timeout doubles the interval (up to 10 minutes); a fast answer brings it back.
- Status line while containers run: `Modal: 1 running (2 containers)`. Deployed apps with no containers cost nothing, so they stay off it.
- A toast when an app has had containers up longer than `alertMinutes` (30), repeated at most every 30 minutes.
- `/modal` opens a pane of apps with state, containers and uptime. **Stop** asks for Confirm, then runs `modal app stop`. Nothing is stopped any other way.
- Shows today's spend and alerts on a `budgetToday` where the Modal CLI supports `billing report` (1.3.3+, Team/Enterprise workspaces). Otherwise `/modal` says why spend isn't shown.
- Finds the CLI as `modal` or `python3 -m modal`. It checks `PATH` first rather than running a command that can only fail, never retries one that isn't there, and stays silent when Modal isn't set up.
- Makes no model calls: only the Modal CLI, never at session start — the first read runs in the background.

## pr-autopilot

Does the "merged #219, clean up branches and start #214" round trip for you, and surfaces CI failures with their logs.

- Watches your open PRs in the session's repo: it adopts them at session start, and picks up every `gh pr create` Claude runs. It polls `gh pr view` every 60s.
- Status line: `PRs: #219 ✓ · #220 CI… · #221 ✗`, for every watched PR.
- **CI toasts only where they're wanted.** A CI pass or failure (with the failing check names) toasts for the PRs this session opened (`gh pr create`) or you added with `/prs watch`, and for any PR whose branch this worktree has checked out. PRs adopted from the repository at start stay on the status line, in `/prs` and in `prs_status`, and still get the merge ritual, but their CI results don't toast — so with seven worktree sessions of one repo a result toasts once, where it matters, not seven times. `toastAdoptedCi` (off) brings back toasts for every watched PR.
- **When a PR merges**, it cleans up with plain local git, then toasts the outcome and suggests carrying on (Tab to accept):
  - `git fetch --prune`, switch to the default branch (only from the PR's own branch) and `git pull --ff-only`.
  - Never with uncommitted changes, never `--force`, never other branches.
  - Deletes the local branch only if it points at exactly the commit GitHub merged, so nothing local is lost. It also leaves a branch checked out in any worktree alone.
  - **In a linked worktree** (`git worktree add`, such as Claude Code's `.claude/worktrees/<name>` sessions) it only fetches: it never switches or pulls there, because the default branch is checked out in the primary worktree and the switch could only fail (`'main' is already used by worktree …`). When the merged branch is the one the worktree has checked out, the toast says `#N merged → this worktree's branch; remove the worktree when you're done (git worktree remove <path>)` and the Tab suggestion tells Claude the branch and worktree stay until you remove them. In the primary worktree the ritual is unchanged.
  - A merge seen mid-turn is cleaned up when the turn ends, so git never races Claude.
- **When you mention failing CI** ("#258 is failing", "CI failed, fix it"), your message goes to Claude with `gh pr checks` and the tail of the failed log attached, so you don't paste it.
- **Claude reads the watched PRs with a tool**, `prs_status` (number, title, state, branch, CI, URL, and how old the data is), instead of running `gh pr view` or `gh pr checks` itself: no API call, and it refreshes first when the data is older than a poll.
- **When gh can't read the checks** (a fine-grained token without "Checks: read" — the cause of `Resource not accessible by personal access token`), it tells you once with the fix (`gh auth login --web`, or grant the token "Checks: read"), keeps polling the PRs *without* their checks so merges are still handled, shows them as `#219 CI?`, and tries the checks again after 30 minutes or when you run `/prs`. If gh can't read PRs at all (not logged in), the status line says `PRs: gh can't read them` and nothing is polled until then. A GitHub rate limit pauses polling for 5 minutes; any other failure doubles the wait up to 10 minutes, back to normal on the next success. Nothing retries every minute forever; the debug log gets one line per change.
- `/prs` lists watched PRs and asks gh again at once. `/prs watch <n|url>` and `/prs forget <n|all>` add and remove them.
- Makes no model calls: only `gh` and `git`, at about one GitHub API call per open PR per minute.

Settings:
- `pollSeconds` (60)
- `authRetryMinutes` (30): how long before the checks are tried again after gh refused them over auth.
- `attachCiLogs` (on)
- `logLines` (120)
- `deleteRemoteBranch` (off): deletes the branch on GitHub too, only while it still points at the merged commit. GitHub's own "Automatically delete head branches" setting does the same job.
- `toastAdoptedCi` (off): toast the CI results of PRs adopted from the repository too, as every PR's used to; with several worktree sessions of one repo, each would toast.

It never closes issues; put "Closes #N" in PR bodies for that.

## recall

Search everything you've done with coding agents, from Claude or from `/recall`. It replaces the broken agent-memory plugin.

- **What it searches:** Claude Code sessions, Codex sessions, subagent and workflow runs, Claude's memory files, standing orders, second-opinion reviews, and your `/remember` notes. Routine (scheduled) runs are left out unless you add `routines:include` to a query.
- **What it keeps:** prompts, answers, compaction summaries, session titles, commands, files touched, commits, PRs, issues, URLs, tasks and **decisions** (what you approved or ruled out). Read-only look-ups like `grep` and `cat` are kept but ranked low.
- **History survives cleanup:** extracts stay searchable after Claude Code deletes old transcripts.
- **Claude searches it itself** with four read-only tools, `search`, `expand`, `recap` and `list`, which run without permission prompts. It checks them when you say "like last time" or "what did we decide", and before asking you something you already settled.
- **The ledger survives compaction:** as a session goes, recall keeps what it has settled — your `/goal` (or the Stop hook's condition), open tasks with a count of the done ones, the questions you asked with the first line of each answer, the files touched, the commits made and PRs opened. After a compaction it goes back into Claude's context as `Ledger (this session, before compaction)` (about 40 lines at most), so you don't have to say "don't lose track of where we were". `/recall ledger` prints it any time; `/clear` starts a fresh one. It is written to `~/.claude/recall/ledger/<session>.json` (readable only by you, secrets masked) so a reload keeps it.
- **Commands:**
  - `/recall <query>` opens a pane of hits grouped by session. **Open** shows the conversation around a hit, **Attach** sends it with your next message, and **Copy resume command** copies `claude --resume <id>`.
  - `/recall last [n]` recaps your last session in this repo: last asks, last answer, PRs, commits, open tasks and decisions. **Send to Claude** attaches it.
  - `/recall ledger` prints this session's ledger (above).
  - `/recall timeline [7d|30d|90d] [all]`
  - `/recall decisions|commands|files|prs|commits|issues|urls|tasks|notes [query]`
  - `/recall ask <question>` answers from your history with Haiku 4.5, citing sessions. It costs a little usage and sends the matching excerpts to the model.
  - `/recall stats`, `/recall reindex`, `/recall forget session <id>|project <name>|before <date>` (asks you to confirm), `/recall help`.
  - `/remember <fact>`, `/remember list`, `/remember forget <ref>`.
- **Bands:**
  - Once per session: `Last session here (2d ago): "…" · PR #99 · 3 open tasks [Recap]`.
  - When a prompt mentions `#214`, `ABC-12`, a file name or a quoted phrase seen in past sessions, a band offers what happened then. Nothing is sent unless you click.
- **Query syntax:** words must all match. `OR` gives alternatives, `"quotes"` an exact phrase, and `-word` excludes. Filters: `project:name`, `kind:decision`, `since:7d`, `until:2026-09-30`, `source:codex`, `routines:include`.
- **Privacy:**
  - The index lives at `~/.claude/recall/index.db`, readable only by you, and never goes in a repo. The ledgers beside it are kept the same way.
  - Secrets are masked before anything is stored: known token shapes, labelled values ("password: …"), the values of secret-named exports in `~/.zshrc`, `~/.zprofile`, `~/.bashrc` and `~/.bash_profile`, and any literal strings you list in `~/.claude/recall/redact.txt` (one per line). Editing that list re-masks the existing index on the next update. The ledger is masked the same way before it is written or shown.
- **Cost:** no model calls except `/recall ask`. The first index takes about 2 minutes in the background, with progress on the status line. After that it updates incrementally at session start, every 10 minutes and at session end — but only when no other session finished an update in the last 10 minutes (`freshMinutes`), checked right before each run: with several sessions open, one update serves them all, and the engine leaves `~/.claude/recall/last-update.json` to say so. The start update waits a random part of 45 s (`startJitterSeconds`), so sessions that start together after a reboot spread out instead of all starting the engine at once; the last-session band does not wait. When another session's update holds the index, this one stands down until its next tick and says so once in the debug log. Updates run under `nice -n 19`, so a loaded Mac stays responsive; searches don't. `/recall reindex` always runs at once, and tells you when another update holds the index.
- **Requires** macOS's `/usr/bin/python3` (Command Line Tools), whose SQLite has FTS5. Nothing else to install.

Settings: `dbPath`, `python`, `sources`, `includeSubagents` (on), `includeRoutines` (off), `updateMinutes` (10), `freshMinutes` (10; 0 never skips), `startJitterSeconds` (45; 0 runs the start update at once), `relatedBand` (on), `lastSessionBand` (on), `maxResults` (8), `askModel` (`claude-haiku-4-5-20251001`).

## repo-brief

Catches Claude up on the repo when a session starts, so you don't have to ask "check the recent commits/PRs and issues".

- Gathers in the background at session start:
  - branch, ahead/behind and uncommitted files
  - the last 8 commits
  - open PRs with CI ✓/✗/…
  - issues labelled `owner`, `todo`, `P0` or `blocked`
  - stale branches (merged into the default branch, or upstream gone). The default branch is what `origin/HEAD` points to, else `origin/main`, `origin/master`, `main`, `master`, else the branch you are on — found with one `git for-each-ref` read, so a clone made without `origin/HEAD` costs no failing command.
- A one-line band above the prompt, e.g. `main ↑1 · 3 changed · PRs #123 ✗ #124 ✓ · 2 owner issues · 2 stale branches · last commit 2h ago`. **Hide** dismisses it.
- Claude gets the same summary once, in its first message, so the prompt cache stays warm. It refreshes after compaction. The gather is started, not awaited, at session start: the first message uses it if it has landed, otherwise waits up to 5 s for a quick one, otherwise goes without.
- When gh's token can't read the PRs (a fine-grained token without "Checks: read", or no login), the brief says `PRs: gh token can't read them` in their place, keeps the issues it could read, and leaves gh alone for 30 minutes instead of failing at every refresh. `/brief` asks again at once.
- `/brief` re-gathers now and prints the full summary.
- Makes no model calls: only `git` and `gh`. The band refreshes after a turn at most every 2 minutes.

Settings: focus labels, refresh minutes, and whether to brief Claude.

## routine-watch

Keeps scheduled routines (daily digests, newsletters) from silently stalling while you're away.

- Knows a session is a routine from its scheduled-task prompt, and does nothing in your other sessions.
- When a routine stops to wait for your OK on a permission prompt, you get a Mac notification and a toast, and the status line shows `routine: daily-report · waiting on you 3m` — but only once the wait has stood 20 s (`waitToastAfterSeconds`). In auto mode the engine decides most permission asks by itself within a few seconds; those are never reported or counted. The notification, the status line and the wait count all change at that same moment, once per wait.
- An `AskUserQuestion` is always for you, so it is reported at once.
- When a turn ends in an error, or the routine finishes, you get a notification: `Routine daily-report finished after 23m · waited on you 2 times` (the waits you were told of).
- **Phone push (optional):** `notifyCommand` runs a command on the same events, e.g. `curl -s -d {message} ntfy.sh/your-topic`. `{title}` and `{message}` are filled in as single arguments, never through a shell.
- **`allowWebReads` (off by default):** lets routines use WebFetch and WebSearch without asking. It only replaces a prompt; your deny rules still apply, and nothing else is ever auto-allowed.
- `/routine` shows the routine's name, how long it has run, its waits, and the settings.
- Makes no model calls.

Settings: Mac notification (on), phone push command (empty), notify on finish (on), `allowWebReads` (off), `waitToastAfterSeconds` (20; 0 reports every ask at once).

## second-opinion

A Fable review in the background, without switching your session's model. **Each run is one Fable call against your usage.**

- `/second-opinion`: reviews recent work. On a feature branch that's the branch against the default branch; otherwise the last 12 commits, plus the diff and `git status`, capped at 60k characters.
- Other forms:
  - `/second-opinion commits 5`
  - `/second-opinion diff` (uncommitted changes)
  - `/second-opinion file docs/ADR-007.md`
  - `/second-opinion <question>`: adds a question for Fable to answer first.
- The command returns at once, and the status line shows `second opinion: reviewing…`. When the review is ready you get a toast, and a pane opens with it, ranked: wrong assumptions, bugs and risks, what's missing, what to do next.
- **Send to Claude** attaches the review to your next prompt (once) and drafts "What do you agree with, and what would you act on?".
- Reviews are saved in `~/.claude/second-opinions/<project>/`. `/second-opinion list` lists them, and `/second-opinion show [n]` reopens one.

Settings: `model` (`claude-fable-5-1`), `effort` (high), `maxContextChars` (60000).

## standing-orders

Keeps your "always / never / don't / from now on" instructions alive across compaction.

- When you write an instruction like "never open bambu with full spectrum files", a band asks: `Keep as a standing order? [Project] [This session] [No]`. Nothing is saved without a click.
- Project orders live in `~/.claude/standing-orders/<repo>.json` and apply to every session in that repo. Session orders and your active `/goal` last for the session.
- Claude gets them at the start of every conversation and again after each compaction or `/clear`, so the prompt cache isn't disturbed. A newly saved order also rides along once with your next message.
- `/orders` lists them. `/orders add [project|session] <text>`, `/orders forget <n>`, `/orders clear session|project`, and `/orders export` (a Markdown block for CLAUDE.md).
- Makes no model calls.

## secret-guard

Stops keys and passwords from going into a prompt, and so into your transcripts, and turns them into env vars instead.

- Catches known token shapes: AWS, GitHub, Anthropic, OpenAI, Slack, Google, Hugging Face, GitLab, npm, Stripe, private keys and bearer tokens.
- Also catches labelled values ("password: …", "api key = …", "the wifi password is …") and the two-line "Access Key ID / Secret Access Key" paste.
- Leaves alone `$NAME` references, placeholders, plain URLs, paths, git SHAs and ordinary prose about passwords.
- On a hit, the prompt isn't sent and goes back in the box. A band shows the secret masked (`…vxrm`) with a suggested name such as `OPENDATALAB_SECRET_ACCESS_KEY`, which you can edit:
  - **Save as env var** appends `export NAME='…'` to `~/.zshrc` (reusing an existing identical export) and replaces the secret in your prompt with `$NAME`.
  - **Send anyway** lets exactly that text through once.
  - **Edit** dismisses the band.
- The value is never shown in toasts, status, state or the transcript, and `/secrets test <text>` output is masked too.
- `/secrets test <text>` shows what would be caught. `/secrets off` and `/secrets on` toggle it for the session.
- Makes no model calls.

Settings: `enabled` (on), `extraPatterns` (a regex), `zshrcPath` (`~/.zshrc`).

## slicer-handoff

Makes Claude's `open` commands hand 3D files to the right slicer.

- **Full-spectrum files go to Snapmaker Orca.** Bambu Studio and OrcaSlicer can't open them. A file counts as full-spectrum when:
  - its name or folder matches `full.?spectrum|snapmaker-only|-fs\.3mf$|-u1[-.]`, or
  - its 3MF names a Full Spectrum filament profile.

  An `open -a BambuStudio …` for one becomes `open -b com.snapmaker.snapmaker-orca …`, with the rest of the command untouched. You get a toast, and Claude gets a note so it doesn't try again.
- **Earlier windows close first.** Before opening a file, it asks the running slicer to quit (a normal quit, never forced), so windows don't pile up. If one won't close, for example because it's waiting on a save prompt, it stops trying and tells Claude to leave it alone.
- `/slice <file> [bambu|snapmaker|orca]` opens a file yourself, with the same rules.
- Recognizes `open -a <app>`, `open -a /Applications/X.app` and `open -b <bundle id>`, including variables set earlier in the command (`S=… && open -a BambuStudio "$S/x.3mf"`) and files copied in the same command.
- Makes no model calls.

Settings:
- `closePrevious` (on): turn it off if you keep your own slicer window open, since the quit request reaches your windows too.
- `fullSpectrumPattern` (the regex above)
- `checkContents` (on)

The quit request goes out when Claude issues the command, before any permission prompt for it.

## stall-alarm

Raises the alarm when a session you walked away from has stalled: a dialog waiting on you, or a turn that died on a login or usage-limit error.

- When a permission prompt or an `AskUserQuestion` has waited for you for 5 minutes (`stallMinutes`), you get a toast and a Mac notification, `Claude has been waiting 5m for your OK: Bash git push origin main`, titled with the project folder so you know which session. While a permission dialog stays open it alarms again every 30 minutes (`repeatMinutes`; 0 = once): it is blocking a goal. A question is quieter, since nothing runs while it waits: it alarms again every 2 hours at most (`questionRepeatMinutes`) and only 3 more times (`questionRepeats`; 0 = once), then stays open quietly, still on the status line.
- When a turn ends on an error that needs you (OAuth / `/login`, not logged in, usage or rate limit, credit balance, billing, overloaded) you get `Claude stopped: <the error> · run /login` at once. Other errors alarm only with `alarmOnAnyError`.
- Status line while a wait is past the threshold: `waiting on you 7m`; cleared when the call runs, is refused, or the turn ends.
- Leaves scheduled routines to routine-watch (`skipRoutines`), so one stall never alarms twice.
- **Phone push (optional):** `notifyCommand` runs a command on each alarm, e.g. `curl -s -d {message} ntfy.sh/your-topic`. `{title}` and `{message}` are filled in as single arguments, never through a shell.
- `/stalls` shows the open waits with their ages, the last alarms and the settings; `/stalls off` and `/stalls on` toggle it for the session.
- Makes no model calls, and runs no process but the notifications.

Settings: `stallMinutes` (5), `repeatMinutes` (30, permission dialogs), `questionRepeatMinutes` (120), `questionRepeats` (3; 0 = alarm once), `notifyMac` (on), `notifyCommand` (empty), `alarmOnAnyError` (off), `skipRoutines` (on).

## usage-meter

A machine-wide meter of the plan's rolling 5-hour usage, so the burn shows before the wall. Every session counts its turns into `~/.claude/usage-meter/turns/<session>.jsonl` and sums every session's last 5 hours (`windowHours`) as **effective tokens** = input + 0.1·cache read + 2·cache write + 5·output, an estimate of what the session limit meters (the weights follow Anthropic's usage explainer). No process runs, no model calls.

- Status line: `usage 5h: 12.4M eff`, then ` · 58% used` while the API's own five-hour reading (the `rateLimits` the last response reported) is fresher than 15 minutes, else ` · 61% of last limit` once a limit hit has taught it the cap, and ` · resets 10:30pm` while a reset is ahead.
- Learns the cap from the hits: the API error `You've hit your session limit · resets 10:30pm (America/Los_Angeles)` (heard as the transcript row, as the classic `StopFailure`, or as the turn's end, counted once) records `{at, resetAt, effectiveAtHit}` in `~/.claude/usage-meter/hits.json`, one per reset time across all sessions, the last 20 kept; the cap estimate is the median of the last three.
- Toasts once when the share first crosses `warnAt` (80%), armed again once it falls back below; and once at the hit itself: `Session limit hit · resets 10:30pm · 14.1M eff in the last 5h, cap estimate updated`.
- Writes `~/.claude/usage-meter/summary.json` for other mods (effort-router's budget cap reads it), at most every `refreshSeconds` (30) and only when the figures changed: `{ ts, windowMs, sessions, tokens: { input, cacheRead, cacheWrite, output }, effective, capEstimate, pct, lastHitAt, nextResetAt }`.
- `/meter` prints the window's totals by category and effective, the estimate and the API's reading, a per-session table (id, turns, subagent turns, effective, share), the hits with the cap estimate, and the weights (`/usage` is Claude Code's own command). The `usage_status` tool returns the same text without a permission prompt, so Claude can check the budget before fanning out subagents or starting optional work.
- Each session's file is rewritten without lines older than the window about once an hour; a file idle for longer than the window is never read.

Settings: `windowHours` (5), `refreshSeconds` (30), `warnAt` (80).

## Loading

- **One session from a terminal:** pass `--plugin-dir` once per mod, e.g. `claude --plugin-dir ~/Projects/claude-mods/job-watch --plugin-dir ~/Projects/claude-mods/pr-autopilot`
- **Every session, including the desktop app:** add to `~/.claude/settings.json`. Put mod-monitor first so it sees the others; `CLAUDE_CODE_PLUGIN_DIR_WATCH` makes desktop sessions pick up edits and show mod failures:
  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1", "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/claude-mods/mod-monitor:~/Projects/claude-mods/job-watch:~/Projects/claude-mods/machine-guard:~/Projects/claude-mods/repo-brief:~/Projects/claude-mods/slicer-handoff:~/Projects/claude-mods/pr-autopilot:~/Projects/claude-mods/routine-watch:~/Projects/claude-mods/modal-meter:~/Projects/claude-mods/second-opinion:~/Projects/claude-mods/downloads-drop:~/Projects/claude-mods/dev-servers:~/Projects/claude-mods/standing-orders:~/Projects/claude-mods/effort-router:~/Projects/claude-mods/secret-guard:~/Projects/claude-mods/recall:~/Projects/claude-mods/stall-alarm:~/Projects/claude-mods/usage-meter" } }
  ```

## Checking

Run with Claude Code 2.1.289 or newer; older CLIs ignore per-test settings, so a few tests fall back to defaults.

```bash
claude plugin validate job-watch && claude plugin test job-watch
claude plugin validate machine-guard && claude plugin test machine-guard
claude plugin validate repo-brief && claude plugin test repo-brief
claude plugin validate slicer-handoff && claude plugin test slicer-handoff
claude plugin validate pr-autopilot && claude plugin test pr-autopilot
claude plugin validate routine-watch && claude plugin test routine-watch
claude plugin validate modal-meter && claude plugin test modal-meter
claude plugin validate second-opinion && claude plugin test second-opinion
claude plugin validate downloads-drop && claude plugin test downloads-drop
claude plugin validate dev-servers && claude plugin test dev-servers
claude plugin validate standing-orders && claude plugin test standing-orders
claude plugin validate effort-router && claude plugin test effort-router
claude plugin validate secret-guard && claude plugin test secret-guard
claude plugin validate recall && claude plugin test recall
claude plugin validate mod-monitor && claude plugin test mod-monitor
claude plugin validate stall-alarm && claude plugin test stall-alarm
claude plugin validate usage-meter && claude plugin test usage-meter
(cd recall/engine && /usr/bin/python3 -m unittest)
```
