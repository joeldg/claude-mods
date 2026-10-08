# recall engine: CLI and JSON contract

`recall.py` indexes past coding-agent sessions into one SQLite FTS5 database and answers queries
with JSON. Standard library only (Python 3.9+, SQLite with FTS5). This file is the contract the
Claude Code plugin builds on; keep it in sync with `recall.py`.

```
/usr/bin/python3 engine/recall.py [--db PATH] [--home PATH] <command> [options]
```

Invoke it plainly as above. Do not add `-I`: on macOS's system Python that also turns off the
bytecode cache (`~/Library/Caches/com.apple.python`) and makes every start ~200 ms slower.

- `--home` (default `$HOME`): where sessions are read from (tests point it at `fixtures/home`).
- `--db` (default `<home>/.claude/recall/index.db`): the index. Its folder is created `0700`, the
  database `0600`.
- Every command prints exactly one JSON object on one line on stdout. On error it prints
  `{"error": "..."}` and exits 1 (bad arguments included). Output is capped at ~200 KB (long strings
  are cut if a result would exceed it).
- Times are epoch milliseconds. Time options accept `7d`, `12h`, `2w`, `3m` (30-day months), `1y`,
  `today`, `yesterday`, `YYYY-MM-DD` (local midnight; as an `until` bound it means the end of that
  day), an ISO time, or epoch ms.
- Project options (`--project`, `project:` in a query) accept a project key (repo root path), its
  basename (case-insensitive), any path inside or a worktree of it, or `all`. A name matching
  nothing gives empty results, not an error.
- A value that starts with `-` must be attached with `=`: `--query=--force`.

## Sources

| source | files | doc `source` |
|---|---|---|
| `claude` | `~/.claude/projects/<mangled-cwd>/<session>.jsonl`; with `--subagents` also `<session>/subagents/**/agent-*.jsonl` (`journal.jsonl` is ignored) | `claude` |
| `codex` | `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/*.jsonl`; titles from `~/.codex/session_index.jsonl` | `codex` |
| `memory` | `~/.claude/projects/*/memory/*.md` | `claude` |
| `orders` | `~/.claude/standing-orders/*.json` (`{root, orders: [{text, addedAt}]}`) | `claude` |
| `reviews` | `~/.claude/second-opinions/<folder>/<stamp>.md` | `claude` |
| notes | only in the database (`note add`) | `recall` |

Project key: one per session, the canonical repo root of the folder the session was launched in
(the `cwd` of its first record; Codex: the session's `cwd`; subagents: their parent's). Every doc of
the session carries that project, so `--project`/`--boost-project` follow sessions; a doc whose
record ran in another folder keeps that folder in `extra.cwd`. Canonical root: `/.claude/worktrees/<name>`,
`/.claude-worktrees/<name>` and `/.claude-worktrees-<name>` suffixes are stripped; if the folder
exists, `git rev-parse --git-common-dir` (3 s timeout, cached in the database per cwd) maps
separate worktree folders and subfolders to the main repo; otherwise the stripped cwd is the key.
`projectName` is the key's basename. Memory folders map to the project of the transcripts beside
them (else the folder name is resolved on disk). Standing orders use their `root`. Reviews map
through the second-opinion mod's folder name (`<slug>-<fnv1a base36>` of the repo root), else by
the `- Project:` name.

Codex subagent threads: `thread_spawn` threads are subagents of their parent thread (indexed with
`--subagents`); guardian/approval-review threads are never indexed.

## Document kinds

Every doc has `kind`, `role`, `ts`, `text` and an `extra` object (fields below; `{}` when none).
Long text is split into ~1,500-character chunks on paragraph boundaries; every chunk of a message
shares its `ref_uuid` and has `extra.chunk` (0-based).

| kind | from | role | extra |
|---|---|---|---|
| `prompt` | human-typed messages (reminders, task notifications, local-command output, IDE/environment context stripped; slash commands as `/x args`; pasted content kept, cut to 1,200 chars each; queued prompts included; a subagent's task prompt, cut to 4,000 chars) | `user` | `routine: true` for a scheduled-task prompt |
| `answer` | assistant text blocks (40+ chars); thinking, images and raw tool output are never indexed | `assistant` | |
| `answer` | the `<summary>` of a background-task notification (low weight) | `notification` | `agent: true, notification: true` |
| `summary` | compaction summaries | `assistant` | |
| `title` | the session title (custom title, else agent name, else AI title, else the Codex thread name); one doc per session, latest wins | `user` | |
| `command` | Bash / Codex shell commands (text = command, then `# description`); `! cmd` typed by the human | `assistant` / `user` | `error` (≤200-char output snippet), `exit`, `interrupted`; `user: true` for typed commands; `inspect: true` for read-only commands (below) |
| `file` | Edit/Write/NotebookEdit/MultiEdit and Codex `apply_patch` paths; one doc per file per session (per agent) | `assistant` | `path`, `edits`, `tool` |
| `commit` | `gitOperation.commit`, `git commit` message (`-m`, `-F -` heredoc, `$(cat <<EOF)`) and `[branch sha] subject` output | `assistant` | `sha`, `message`, `branch`, `kind` |
| `pr` | `pr-link` records, `gitOperation.pr`, `gh pr create` output URLs (title from `--title`/`-t`); one per PR per session | `assistant` | `number`, `url`, `repo`, `title`, `action` |
| `issue` | `gh issue create` output URLs (title from `--title`/`-t`) | `assistant` | `number`, `url`, `repo`, `title` |
| `url` | WebFetch URLs (+ the fetch prompt), WebSearch / Codex web-search queries | `assistant` | `url` or `query`, `tool` |
| `decision` | (a) a short choice/approval reply to an assistant question → `Q: <last ~300 chars of the ask> → A: <reply>`; (b) human sentences with explicit decision language; (c) AskUserQuestion answers | `user` | `via`: `reply`, `statement`, `question` |
| `task` | TaskCreate/TaskUpdate (final state per task; deleted tasks removed), TodoWrite and Codex `update_plan` (the last list wins) | `assistant` | `status`, `subject`, `taskId`, `description` |
| `memory` | memory files (front matter `name: description` heads the text) | `assistant` | `file`, `name`, `type`, `originSession` |
| `order` | one per standing order | `user` | `file`, `root` |
| `review` | second-opinion reviews (`Second opinion: <subject>` heads the text) | `assistant` | `file`, `subject`, `model` |
| `note` | `note add` | `user` | |

Every doc may also carry `extra.cwd`: the record's working folder when it differs from the folder
the session was launched in.

Inspection commands: a command whose every part only reads or prints is flagged `inspect: true`
(docs.flags bit 1) — e.g. `cat`, `sed -n`, `head`/`tail`, `grep`/`rg`, `ls`, `find` (without
`-delete`/`-exec` of an action), `wc`, `stat`, `echo`, `pwd`, `which`, `ps`, `lsof`, `df`/`du`,
`sleep`, `date`, `jq`, `git status|log|diff|show|rev-parse|blame|…` and listing forms of `git
branch|remote|stash|tag|worktree|config`, `gh pr view|list|checks|diff`, `gh issue view|list`,
`gh run view|list|watch`, `gh api` GETs, `docker ps|logs|…`, and Python one-liners or `python -`
heredocs that only print. Commands are split on `;` `&&` `||` `|` `&` and newlines (heredoc bodies
aside); `cd`/`export`/loop keywords are neutral; any part that writes a file (`>`, `>>`, `tee`,
`sed -i`), deletes, installs, commits, pushes, runs a program or calls the network makes the whole
command an action (`cd x && modal run …` is an action).

Decisions are never taken from routine (scheduled-task) prompts, subagents, fenced or indented code,
questions, or conditional clauses (`if … approved`); imperative `Approve X` is an instruction, not
a decision.

Subagent docs belong to their parent session (`session` is the parent id). In search hits and list
items their `extra` also has `subagent: true`, `agent` (the agent's description/type from its
`.meta.json`, or its first prompt) and `report: true` on the subagent's final assistant message
(its report back). Subagent prompts never count as the parent's prompts, and sessions listings
(`recap`, `timeline`, `projects`, search `sessions`) only ever show parent sessions.

Secrets are masked before anything is stored (docs, FTS index, parser state): known token shapes
(AWS key ids and a 40-char secret near one, GitHub `gh?_`/`github_pat_`, `sk-ant-`, `sk-`/`sk-proj-`,
Slack `xox?-`, Google `AIza`, `hf_`, `glpat-`, `npm_`, Stripe `sk_live_`/`rk_live_`), PEM private
keys, `Bearer` tokens, passwords in URLs and labelled values (`password`, `secret`, `token`,
`api key`, `access key (id)`, `secret (access) key`, `client secret`, `wifi password`… followed by
`:`, `=`, ` is ` or a newline and an 8+ character value). `$NAME`/`${NAME}` references, env lookups,
function calls and placeholders are left alone. A masked value reads `[secret …last4]`.

## Literal redaction

Exact strings that patterns cannot catch (a Wi-Fi password inside a shell command…) are masked the
same way, before anything is stored or indexed:

- `<home>/.claude/recall/redact.txt`: one literal per line; blank lines and lines starting with `#`
  are ignored; surrounding whitespace is trimmed; literals under 6 characters are ignored. The
  engine never creates or edits this file.
- `export NAME=value` lines (also `'value'`, `"value"`, with a trailing `# comment`) in
  `<home>/.zshrc`, `.zprofile`, `.bashrc`, `.bash_profile` whose NAME matches
  `KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL|AUTH|PRIVATE` (any case) and whose value has
  8+ characters. Skipped: values with `$`/backtick expansions, paths starting with `/` or `~`, and
  URLs without credentials (a URL counts when it has `user:pass@` or a `key=`/`token=`/… query
  parameter). Nothing is executed.
- Matching is case-sensitive, on the whole literal (regex-escaped), longest first.
- Literal values are never printed (output, errors, stats or progress) and never stored. The
  database keeps only a salted PBKDF2-SHA256 hash of the set and the source files' sizes/mtimes, in
  `meta`.
- When an `update` finds the set changed, it first re-masks every stored text containing a literal
  (doc text and its FTS entries, `extra` fields, session titles and first prompts, parser state),
  rebuilds the FTS index and truncates the WAL (with `secure_delete`), so the old values do not
  remain in the file; `updated.remasked` then gives the number of docs changed (absent when nothing
  ran). An unchanged set costs nothing.

## remask

```
remask   → {"remasked": {"docs": 0, "seconds": 0.25}}      (or {"remasked": null, "busy": true})
```

Re-applies all masking (literals and patterns) to everything stored, whatever the hash says, and
records the current set. Waits up to 60 s for a running update. About 0.3 s to scan ~95k docs; a
literal found in ~1,800 of them took 1.7 s in all.

## update

```
update [--sources claude,codex,memory,orders,reviews] [--subagents] [--prune-deleted]
       [--retention-days N] [--max-seconds N] [--progress] [--rebuild]
```

```json
{"updated": {"files": 3, "docs_added": 120, "docs_removed": 0, "sessions": 2, "seconds": 0.4, "partial": false},
 "stats": {"...": "same object as the stats command"}}
```

- Another `update` already running: `{"updated": null, "busy": true}` (exit 0, immediately).
- `updated.errors` (count) appears only when some file could not be read; the others still index.
- Transcripts are append-only: each file's byte offset after its last complete line is kept and only
  new bytes are read. A half-written last line waits for the next run. A file that shrank or whose
  first bytes changed is re-indexed from the start (with its copies under other project folders).
  Records are deduplicated by (session id, uuid) across copies of a session.
- A transcript that disappears keeps its docs (`transcriptExists: false`); `--prune-deleted` drops
  them. A deleted memory/order/review file drops its docs on the next update (they mirror the file).
- `--subagents`: also index subagent transcripts (and sidechain records inside main transcripts).
  Passing it after earlier runs without it picks up everything skipped so far (subagent files, Codex
  spawned threads, transcripts holding sidechain records).
- A session with no searchable docs (an empty or never-completed transcript) gets no session row.
- `--max-seconds N`: stop early (`partial: true`); the next run resumes. Recent files go first.
- `--progress`: JSON lines on stderr,
  `{"progress":{"files_done":n,"files_total":n,"bytes_done":n,"bytes_total":n}}`.
- `--retention-days N`: drop docs older than N days (notes are kept) and sessions left without docs.
- `--rebuild`: re-read every file from the start (notes and forgotten items stay).
- Index format: when the engine's extraction changes, files indexed by an older format are re-read
  once by the next `update` (resumable with `--max-seconds`), and docs of transcripts that no longer
  exist are brought up to date in place (inspection flags, pieces column, session project). No
  `--rebuild` is needed after an upgrade. A schema-1 database is migrated in place on first open.

## search

```
search --query Q [--project KEY|NAME|all] [--boost-project KEY|NAME] [--exclude-session ID]
       [--kinds k1,k2] [--since T] [--until T] [--limit 8] [--routines include|exclude|only]
       [--source claude|codex|all] [--half-life-days 45]
```

Query syntax in `Q`: plain terms (all must match), `"quoted phrases"`, `OR` between terms,
`-term` / `-"phrase"` / `NOT term` to exclude, `term*` for a prefix, and filters `project:NAME`,
`kind:K` (or `kind:a,b`), `since:7d`, `until:DATE`, `source:codex`, `session:ID`,
`routines:include|exclude|only` (quote values with spaces: `project:"my app"`). Filters in `Q`
override the flags. Any input is accepted: anything FTS5 would reject falls back to a quoted-terms
query, and a query with nothing searchable returns no hits. A query with filters but no terms lists
matching docs, weighted by kind and recency.

Tokenizer: `porter unicode61 tokenchars '-_'`, so `SF-034`, `best_pt`, `my-project` are single
tokens. A second column holds, for each hyphen/underscore compound, the compound without leading or
trailing dashes (`--flag-name` → `flag-name`) and its pieces as a phrase (`flag name`). A query term
with `-`/`_` is expanded the same way: `delete-branch-on-merge` searches
`("delete-branch-on-merge" OR "delete branch on merge")`, so it finds `--delete-branch-on-merge`,
the plain words and the pieces; `--flag` in a query is a term, not an exclusion. Porter stems whole
tokens (`learning-rate` → `learning-r`), so a whole-token prefix query matches only up to the stem
(the pieces phrase still takes the prefix: `learning-rat*` finds "learning rate").

Ranking: `(bm25 + ε)` × kind weight (note 3, decision 2.5, summary 2, title 2, memory 2, order 2,
pr/commit/issue 1.8, prompt 1.5, command 1.2, review 1.2, answer 1, file 1, url 0.8, task 0.8) ×
recency (`0.5 ^ (age / half-life)`, half-life 45 days) × 1.5 for `--boost-project` × 0.5 for routine
sessions (unless `--routines only`) × 0.6 for subagent docs other than their final report × 0.5 for
task-notification summaries × 0.3 for inspection commands. Near-identical hits (same session, same leading text) are collapsed.

```json
{"query": "cosine schedule", "total": 12,
 "hits": [{"ref": "d123", "session": "uuid", "project": "/Users/me/project", "projectName": "project",
           "title": "Widget model training", "ts": 1788253230000, "kind": "decision", "role": "user",
           "source": "claude", "snippet": "We will use the [[cosine schedule]] for…", "score": 3.2,
           "extra": {"via": "statement"}}],
 "sessions": [{"session": "uuid", "title": "...", "projectName": "project", "hits": 4,
               "lastTs": 1788253230000, "transcriptExists": true}]}
```

- `total`: all matching docs (after filters); `hits`: at most `--limit` (max 100), best first.
- `snippet`: ≤240 chars, matches wrapped in `[[ ]]` (FTS5 `snippet()`; piece-only matches are
  highlighted the same way).
- `session`/`project` are `null` for memory, orders, reviews and notes (notes may also have no
  project; project-less notes match every project filter). `title` is the session title, else the
  start of its first prompt, else the memory name / review subject / `Standing order` / `Note`.
- `sessions`: the sessions of the best ~200 matches, by best match (max 10).

## expand

```
expand --ref d123 [--before 4] [--after 4] [--max-chars 6000]
```

The prompt/answer/summary/decision/command docs just before and after the focus doc, in order
(the focus is included whatever its kind). For a subagent doc the neighbours come from the same
subagent transcript; for a main doc only from the main conversation; for memory/review/order docs
from the same file. The items' texts always total at most `--max-chars` (max 50,000): the focus
keeps the larger share, the rest is split evenly, and the farthest neighbours are dropped before any
item would get under 80 characters.

```json
{"session": {"session": "uuid", "title": "...", "project": "/Users/me/project", "projectName": "project",
             "start": 1788253230000, "end": 1788260000000, "source": "claude",
             "resume": "claude --resume uuid", "transcriptExists": true, "transcriptPath": "/.../uuid.jsonl"},
 "focus": "d123",
 "items": [{"ref": "d120", "ts": 1788253230000, "kind": "prompt", "role": "user", "text": "..."}]}
```

- `session` is `null` for docs outside sessions. Codex sessions resume with `codex resume <id>`.
- Subagent focus: `session.agent` names the agent and each item has `subagent: true`.
- Inspection commands among the items have `inspect: true`.

## recap

```
recap [--project KEY|NAME] [--session ID] [--exclude-session ID] [--count 1] [--routines include|exclude|only]
```

The most recent session(s) of the project (all projects when omitted), or the given session.

```json
{"sessions": [{"session": "uuid", "title": "...", "projectName": "project", "start": 1788253230000,
               "end": 1788260000000, "prompts": 7, "routine": false, "firstPrompt": "...",
               "lastPrompts": ["...", "...", "..."], "lastAnswer": "... (≤1500 chars)",
               "commits": [{"sha": "abc1234", "message": "first line"}],
               "prs": [{"number": 12, "url": "...", "title": "..."}],
               "issues": [{"number": 34, "url": "...", "title": "..."}],
               "files": ["path", "... top 12 by edits"], "openTasks": ["..."],
               "decisions": ["... up to 5, newest first"], "resume": "claude --resume uuid",
               "transcriptExists": true}]}
```

`--count` max 10. Commits, PRs and files include the session's subagents' work. An unknown
`--session` is an error.

## timeline

```
timeline [--project KEY|NAME|all] [--since 14d] [--limit 60] [--routines include|exclude|only]
```

```json
{"days": [{"date": "2026-10-06", "sessions": [{"session": "uuid", "title": "...", "projectName": "project",
           "start": 1788253230000, "end": 1788260000000, "prompts": 3, "commits": 1, "prs": 0,
           "routine": false, "source": "claude"}]}]}
```

Days are local dates of each session's start, newest first; `--limit` (max 500) caps sessions.

## list

```
list --kind decision|command|file|commit|pr|issue|url|note|task|order|review|prompt|answer|summary|title|memory
     [--query Q] [--project KEY|NAME|all] [--since T] [--until T] [--limit 20] [--include-inspect]
```

`--kind command` leaves out inspection commands unless `--include-inspect` is given.

```json
{"items": [{"ref": "d1", "ts": 1788253230000, "session": "uuid", "projectName": "project", "title": "...",
            "kind": "decision", "text": "... (≤1000 chars)", "extra": {}}]}
```

Newest first; `--query` (same syntax as search, terms only) filters; `--limit` max 200.

## notes

```
note add --text T [--project KEY|NAME]   → {"note": {"ref": "d999", "ts": 1791400000000, "projectName": "project", "text": "..."}}
note list [--project KEY|NAME|all] [--limit 50]   → {"items": [...same shape as list...]}
note forget --ref d999                   → {"forgotten": 1}   (0 when already gone; an error for a non-note ref)
```

A note without `--project` is global. Notes live only in the database: re-indexing never removes
them. Secrets in notes are masked too.

## forget

```
forget --session ID | --project KEY|NAME | --before T   → {"forgotten": {"docs": n, "sessions": n}}
```

Deletes the docs (notes included) and session rows, and remembers the request so later updates do
not bring them back: records of a forgotten session/project dated at or before the forget, and
everything before a `--before` date, stay out. Newer activity in the same transcript is indexed.
Waits (up to 30 s) for a running update.

## projects

```json
{"projects": [{"key": "/Users/me/project", "name": "project", "paths": ["/Users/me/project",
               "/Users/me/project/.claude/worktrees/x"], "sessions": 3, "lastTs": 1788253230000}]}
```

Newest first; `paths` are the working folders seen (max 20). Projects that only have memory,
orders, reviews or notes are listed with `sessions: 0`.

## stats

```json
{"db": "/Users/me/.claude/recall/index.db", "bytes": 74390168, "sessions": 65, "docs": 41086,
 "byKind": {"answer": 13814}, "bySource": {"claude": 24836, "codex": 16250},
 "oldest": 1777068925823, "newest": 1791428117001, "lastUpdate": 1791429927165,
 "transcriptsDeleted": 0, "routineSessions": 20, "subagentDocs": 0, "projects": 19,
 "inspectCommands": 28373, "redactLiterals": 3}
```

`bytes` counts the database and its WAL. `subagentDocs`, `projects`, `inspectCommands` and
`redactLiterals` (a count only) are additions beyond the original contract.

## Concurrency and storage

- WAL mode; `update` holds an exclusive lock file (`<db>.lock`), a second `update` answers busy at
  once; searches never wait for an update.
- `forget`, `note forget`, `remask` and pruning updates zero freed pages (`secure_delete`).
- Tables: `files` (offset, head hash, parser state, index format per file), `sessions`, `docs`
  (metadata, `flags`),
  `docs_text` (`text` and `parts`, the FTS5 external content, kept apart so ranking only touches
  small rows), `docs_fts`, `uuids` (dedupe), `forgotten`, `cwd_projects` (project cache),
  `project_paths`, `meta` (`schema_version`, `last_update`). The view `docs_all` joins `docs` and
  `docs_text` for ad-hoc inspection.
- Schema 2 (this engine) adds `docs.flags` and `files.fmt`; a schema-1 database is upgraded in
  place. A database from an unknown newer schema is refused with an error.

## Additions beyond the original contract

- `update --rebuild`; `updated.errors` when files failed; `updated.remasked` after a literal-set change.
- `remask`; literal redaction (`redact.txt`, shell exports); `list --include-inspect`; `extra.inspect`,
  `extra.cwd`; one project per session.
- `search --half-life-days`; `routines:` query filter; `recap --routines`; `timeline --routines only`;
  `list --until`; `note list --limit`.
- Hit/item `extra.subagent`, `extra.agent`, `extra.report`; expand `session.agent`, item `subagent`.
- `stats.subagentDocs`, `stats.projects`.
- Codex `archived_sessions` are indexed; guardian review threads never are.
- Titles fall back to the start of the first prompt when a session has none.
