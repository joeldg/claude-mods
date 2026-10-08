# claude-mods

Claude Code mods (function-hook plugins) I find helpful. Each folder is one plugin.

Requires a Claude Code build with function-hook plugins (2.1.289 or newer). machine-guard reads macOS tools (`sysctl`, `memory_pressure`, `ioreg`).

```bash
git clone https://github.com/joeldg/claude-mods ~/Projects/claude-mods
```

## dev-servers

A pane of your project's running dev servers, so you don't have to ask Claude to restart them.

- `/servers` opens the **Servers** pane:
  - running servers whose working folder is in this repo: name, port, pid and uptime, with **Restart**, **Stop** and **Log**
  - known start commands that aren't running, with **Start**: `package.json` `dev`/`start`/`serve`/`preview` scripts (run with your lockfile's package manager), `.claude/launch.json` and `Procfile`
  - a count of other listeners on the Mac
- Only button presses start or stop anything:
  - **Start** runs the command detached, logging to `~/.claude/dev-servers/<project>/`.
  - **Stop** sends SIGTERM. If the server ignores it, pressing again within 10s force-stops it.
  - **Restart** stops the server, waits for the port to free up, then starts it.
  - Before any signal, it checks the pid still runs the same command.
- When a command fails with "address already in use", Claude gets a note (and you a toast) naming the holder, e.g. `Port 4000 is held by node (pid 123, up 2h, in /Users/me/other)`.
- Status line: `servers: :4000 :5173`.
- Makes no model calls: `lsof` and `ps` every 15s.

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
- **Model guard:** set `avoidModel` (a regex such as `fable`) to send those requests to `fallbackModel` instead, subagents included.
- `/route` shows the last decision and the session's counts. `/route off` and `/route on` toggle it; `/route deep` and `/route routine` force the next turn.
- Status line while a turn is routed: `effort: low (routine)`.
- Makes no model calls.

Settings: `routineEffort` (low), `deepEffort` (max), `routinePattern`, `deepPattern`, `avoidModel`, `fallbackModel` (opus), `stickyTurns` (2), `freeSwitchTokens` (30000), `cacheTtlMinutes` (60).

## job-watch

A **Jobs** pane for long-running work: training runs, downloads, extractions.

- Picks up background Bash tasks and detached `nohup … > log &` launches by itself.
- `/watch <log> [label]` adds any other log file.
- Shows progress, ETA and the last log line, and flags a job as stalled when its log goes quiet.
- Shows free space on `/` and `/Volumes/*` (the NAS).
- Toasts when a job finishes or stalls. The status line shows `jobs: 2 running · 1 stalled`.
- `/jobs` opens the pane, `/unwatch <label|done|all>` removes jobs.
- Makes no model calls: it reads logs with `tail`, checks processes with `ps`, and runs `df`.

Settings (in `/config`): stall minutes (10), refresh seconds (10), how long finished jobs stay (120 min), auto-open (on), which disks to show.

## machine-guard

Memory, swap and GPU on the status line. It refuses heavy local jobs when the Mac can't take them.

- Status line: `RAM tight 12% free · swap 7.9/8G · top python 31G · GPU 87%`.
- It refuses heavy jobs (training, inference, rendering, extraction, Blender, Docker, ffmpeg) when:
  - macOS reports **critical** memory pressure, or
  - the Mac is **reserved** with `/busy`.

  When memory is only tight, the job runs and Claude gets a note to start one heavy job at a time.
- `/busy 3h training a vision model` reserves the Mac in **every** Claude session. `/busy off` lifts it. The reservation lives in `~/.claude/machine-guard.json`, so a training script can write it too:
  ```bash
  echo '{"reason":"overnight training","until":'$(( ($(date +%s) + 8*3600) * 1000 ))'}' > ~/.claude/machine-guard.json
  ```
- `/guard` shows what it sees. `/guard pause 15m` lets heavy jobs through in this session; `/guard on` resumes the guard.
- Remote runs (`modal run`, `ssh`), tests (`pytest`) and installs are never treated as heavy.
- Add your own heavy commands with the "Also heavy" setting (a regex), e.g. `overnight_|nightly_run\.sh`.

## mod-monitor

Watches how the other mods behave in real use, without changing them. It is listed first in `CLAUDE_CODE_PLUGIN_DIRS`, so the other mods' hooks run beneath it.

- **Failures:** any mod hook that throws, times out or rejects, read from the hook chain's results (`next.trace`), with the mod's name, the event and how long it ran. Slow hooks (over 1.5 s) are recorded too. The first failure of each mod in a session raises a toast.
- **What each mod did:** its toasts ("#219 merged → …", "Blocked: …"), status-line changes, the mod commands you used (never their arguments), and failed subprocesses (a burst of 5 in 10 minutes raises a toast). Git checks run outside a repository are logged as expected, not as failures. It also records model calls (the only usage the mods cost: `/second-opinion`, `/recall ask`) and file writes (folders only, never contents).
- **`/mods`:** a pane with one row per mod: ✓ active, ⚠ failing, ✗ not seen this session, · seen but idle. Each row shows today's counts and last activity, with **Details** for its recent events. It also says which mods it can't see, if any of them run above it.
- **`/mods report [24h|7d|30d]`:** a per-mod report across all sessions, also written to `~/.claude/mods/monitor/report-latest.md` for a scheduled review or Claude to read.
- **`/mods failures [7d]`:** failures and failed subprocesses only.
- **Logs:** `~/.claude/mods/monitor/<date>/<session>.jsonl`, flushed every minute and at session end, with secrets masked and old days removed after 30 days.
- Makes no model calls and adds no measurable latency.
- **What it can't see:** effort-router's per-request stream (`turn.step`) and secret-guard's transcript-row hook (`session.append`).

Settings: `alerts` (on), `slowMs` (1500), `watchRender` (on), `watchCommands` (on; off stops "mod-monitor" appearing beside other mods' command output), `retentionDays` (30), `flushSeconds` (60).

## modal-meter

Keeps an eye on Modal so idle GPU containers don't burn credits.

- Status line while containers run: `Modal: 1 running (2 containers)`. Deployed apps with no containers cost nothing, so they stay off it.
- A toast when an app has had containers up longer than `alertMinutes` (30), repeated at most every 30 minutes.
- `/modal` opens a pane of apps with state, containers and uptime. **Stop** asks for Confirm, then runs `modal app stop`. Nothing is stopped any other way.
- Shows today's spend and alerts on a `budgetToday` where the Modal CLI supports `billing report` (1.3.3+, Team/Enterprise workspaces). Otherwise `/modal` says why spend isn't shown.
- Finds the CLI as `modal` or `python3 -m modal`, and stays silent when Modal isn't set up.
- Makes no model calls: only the Modal CLI, every 60s.

## pr-autopilot

Does the "merged #219, clean up branches and start #214" round trip for you, and surfaces CI failures with their logs.

- Watches your open PRs in the session's repo: it adopts them at session start, and picks up every `gh pr create` Claude runs. It polls `gh pr view` every 60s.
- Status line: `PRs: #219 ✓ · #220 CI… · #221 ✗`. Toasts when CI fails (with the failing check names) or passes.
- **When a PR merges**, it cleans up with plain local git, then toasts the outcome and suggests carrying on (Tab to accept):
  - `git fetch --prune`, switch to the default branch (only from the PR's own branch) and `git pull --ff-only`.
  - Never with uncommitted changes, never `--force`, never other branches.
  - Deletes the local branch only if it points at exactly the commit GitHub merged, so nothing local is lost. It also leaves a branch checked out in another worktree alone.
  - A merge seen mid-turn is cleaned up when the turn ends, so git never races Claude.
- **When you mention failing CI** ("#258 is failing", "CI failed, fix it"), your message goes to Claude with `gh pr checks` and the tail of the failed log attached, so you don't paste it.
- `/prs` lists watched PRs. `/prs watch <n|url>` and `/prs forget <n|all>` add and remove them.
- Makes no model calls: only `gh` and `git`, at about one GitHub API call per open PR per minute.

Settings:
- `pollSeconds` (60)
- `attachCiLogs` (on)
- `logLines` (120)
- `deleteRemoteBranch` (off): deletes the branch on GitHub too, only while it still points at the merged commit. GitHub's own "Automatically delete head branches" setting does the same job.

It never closes issues; put "Closes #N" in PR bodies for that.

## recall

Search everything you've done with coding agents, from Claude or from `/recall`. It replaces the broken agent-memory plugin.

- **What it searches:** Claude Code sessions, Codex sessions, subagent and workflow runs, Claude's memory files, standing orders, second-opinion reviews, and your `/remember` notes. Routine (scheduled) runs are left out unless you add `routines:include` to a query.
- **What it keeps:** prompts, answers, compaction summaries, session titles, commands, files touched, commits, PRs, issues, URLs, tasks and **decisions** (what you approved or ruled out). Read-only look-ups like `grep` and `cat` are kept but ranked low.
- **History survives cleanup:** extracts stay searchable after Claude Code deletes old transcripts.
- **Claude searches it itself** with four read-only tools, `search`, `expand`, `recap` and `list`, which run without permission prompts. It checks them when you say "like last time" or "what did we decide", and before asking you something you already settled.
- **Commands:**
  - `/recall <query>` opens a pane of hits grouped by session. **Open** shows the conversation around a hit, **Attach** sends it with your next message, and **Copy resume command** copies `claude --resume <id>`.
  - `/recall last [n]` recaps your last session in this repo: last asks, last answer, PRs, commits, open tasks and decisions. **Send to Claude** attaches it.
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
  - The index lives at `~/.claude/recall/index.db`, readable only by you, and never goes in a repo.
  - Secrets are masked before anything is stored: known token shapes, labelled values ("password: …"), the values of secret-named exports in `~/.zshrc`, `~/.zprofile`, `~/.bashrc` and `~/.bash_profile`, and any literal strings you list in `~/.claude/recall/redact.txt` (one per line). Editing that list re-masks the existing index on the next update.
- **Cost:** no model calls except `/recall ask`. The first index takes about 2 minutes in the background, with progress on the status line. After that it updates incrementally (about 1s) at session start and every 10 minutes.
- **Requires** macOS's `/usr/bin/python3` (Command Line Tools), whose SQLite has FTS5. Nothing else to install.

Settings: `dbPath`, `python`, `sources`, `includeSubagents` (on), `includeRoutines` (off), `updateMinutes` (10), `relatedBand` (on), `lastSessionBand` (on), `maxResults` (8), `askModel` (`claude-haiku-4-5-20251001`).

## repo-brief

Catches Claude up on the repo when a session starts, so you don't have to ask "check the recent commits/PRs and issues".

- Gathers in the background at session start:
  - branch, ahead/behind and uncommitted files
  - the last 8 commits
  - open PRs with CI ✓/✗/…
  - issues labelled `owner`, `todo`, `P0` or `blocked`
  - stale branches (merged, or upstream gone)
- A one-line band above the prompt, e.g. `main ↑1 · 3 changed · PRs #123 ✗ #124 ✓ · 2 owner issues · 2 stale branches · last commit 2h ago`. **Hide** dismisses it.
- Claude gets the same summary once, in its first message, so the prompt cache stays warm. It refreshes after compaction.
- `/brief` re-gathers now and prints the full summary.
- Makes no model calls: only `git` and `gh`. The band refreshes after a turn at most every 2 minutes.

Settings: focus labels, refresh minutes, and whether to brief Claude.

## routine-watch

Keeps scheduled routines (daily digests, newsletters) from silently stalling while you're away.

- Knows a session is a routine from its scheduled-task prompt, and does nothing in your other sessions.
- When a routine stops to wait for your OK on a permission prompt or an `AskUserQuestion`, you get a Mac notification and a toast, and the status line shows `routine: daily-report · waiting on you 3m`.
- When a turn ends in an error, or the routine finishes, you get a notification: `Routine daily-report finished after 23m · waited on you 2 times`.
- **Phone push (optional):** `notifyCommand` runs a command on the same events, e.g. `curl -s -d {message} ntfy.sh/your-topic`. `{title}` and `{message}` are filled in as single arguments, never through a shell.
- **`allowWebReads` (off by default):** lets routines use WebFetch and WebSearch without asking. It only replaces a prompt; your deny rules still apply, and nothing else is ever auto-allowed.
- `/routine` shows the routine's name, how long it has run, its waits, and the settings.
- Makes no model calls.

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

## Loading

- **One session from a terminal:** pass `--plugin-dir` once per mod, e.g. `claude --plugin-dir ~/Projects/claude-mods/job-watch --plugin-dir ~/Projects/claude-mods/pr-autopilot`
- **Every session, including the desktop app:** add to `~/.claude/settings.json`. Put mod-monitor first so it sees the others; `CLAUDE_CODE_PLUGIN_DIR_WATCH` makes desktop sessions pick up edits and show mod failures:
  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1", "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/claude-mods/mod-monitor:~/Projects/claude-mods/job-watch:~/Projects/claude-mods/machine-guard:~/Projects/claude-mods/repo-brief:~/Projects/claude-mods/slicer-handoff:~/Projects/claude-mods/pr-autopilot:~/Projects/claude-mods/routine-watch:~/Projects/claude-mods/modal-meter:~/Projects/claude-mods/second-opinion:~/Projects/claude-mods/downloads-drop:~/Projects/claude-mods/dev-servers:~/Projects/claude-mods/standing-orders:~/Projects/claude-mods/effort-router:~/Projects/claude-mods/secret-guard:~/Projects/claude-mods/recall" } }
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
(cd recall/engine && /usr/bin/python3 -m unittest)
```
