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

## Loading

- **One session from a terminal:** `claude --plugin-dir ~/Projects/claude-mods/job-watch --plugin-dir ~/Projects/claude-mods/machine-guard`
- **Every session, including the desktop app:** add to `~/.claude/settings.json`:
  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/claude-mods/job-watch:~/Projects/claude-mods/machine-guard" } }
  ```

## Checking

```bash
claude plugin validate job-watch && claude plugin test job-watch
claude plugin validate machine-guard && claude plugin test machine-guard
```
