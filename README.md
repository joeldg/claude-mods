# claude-mods

Claude Code mods (function-hook plugins) I find helpful. Each folder is one plugin.

Requires a Claude Code build with function-hook plugins (2.1.289 or newer). machine-guard reads macOS tools (`sysctl`, `memory_pressure`, `ioreg`).

```bash
git clone https://github.com/joeldg/claude-mods ~/Projects/claude-mods
```

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

- **One session from a terminal:** `claude --plugin-dir ~/Projects/claude-mods/job-watch --plugin-dir ~/Projects/claude-mods/machine-guard`
- **Every session, including the desktop app:** add to `~/.claude/settings.json`:
  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/claude-mods/job-watch:~/Projects/claude-mods/machine-guard:~/Projects/claude-mods/repo-brief:~/Projects/claude-mods/slicer-handoff" } }
  ```

## Checking

```bash
claude plugin validate job-watch && claude plugin test job-watch
claude plugin validate machine-guard && claude plugin test machine-guard
claude plugin validate repo-brief && claude plugin test repo-brief
claude plugin validate slicer-handoff && claude plugin test slicer-handoff
```
