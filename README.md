# claude-mods

Claude Code mods (function-hook plugins) I find helpful. Each folder is one plugin.

Requires a Claude Code build with function-hook plugins (2.1.289 or newer). machine-guard reads macOS tools (`sysctl`, `memory_pressure`, `ioreg`).

```bash
git clone https://github.com/joeldg/claude-mods ~/Projects/claude-mods
```

## downloads-drop

Puts files you just downloaded into your prompt with one click.

- Watches `~/Downloads` (top level). When a new file arrives (PDF, Markdown, images, 3MF/STL/OBJ, zip, video…), a band appears above the prompt: `New in Downloads: paper.pdf, model-b.3mf · 2m ago [Attach] [Dismiss]`.
- **Attach** puts `@"/Users/you/Downloads/paper.pdf"` mentions in your prompt. **Dismiss** hides those files.
- Waits until a file has finished downloading (skips partial downloads and files still growing), and ignores hidden and zero-byte files.
- `/downloads` lists the 10 newest files, numbered. `/downloads attach 1 3` (or `2-4`) adds those, and `/downloads clear` dismisses everything new.
- Stacks with other mods' bands (repo-brief, standing-orders, secret-guard) instead of hiding them.
- Makes no model calls.

Settings: `folder` (`~/Downloads`), `extensions`, `pollSeconds` (5), `maxAgeMinutes` (120).

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
- **Every session, including the desktop app:** add to `~/.claude/settings.json`:
  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/claude-mods/job-watch:~/Projects/claude-mods/machine-guard:~/Projects/claude-mods/repo-brief:~/Projects/claude-mods/slicer-handoff:~/Projects/claude-mods/pr-autopilot:~/Projects/claude-mods/routine-watch:~/Projects/claude-mods/modal-meter:~/Projects/claude-mods/second-opinion:~/Projects/claude-mods/downloads-drop" } }
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
```
