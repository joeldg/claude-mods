"""Tests for the recall engine. Run: cd recall/engine && /usr/bin/python3 -m unittest -v

Everything runs against synthetic fixtures copied to a temporary folder; secret-shaped strings are
assembled at runtime from obviously fake parts.
"""
import fcntl
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RECALL = os.path.join(HERE, 'recall.py')
FIXTURES = os.path.join(HERE, 'fixtures', 'home')
sys.path.insert(0, HERE)
import recall  # noqa: E402

A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'
C = '33333333-3333-4333-8333-333333333333'
D = '44444444-4444-4444-8444-444444444444'
CX = '55555555-5555-4555-8555-555555555555'
CG = '66666666-6666-4666-8666-666666666666'
PROJ = '/Users/me/project'
ACME = '/Users/me/acme/widgets'
A_MAIN = '.claude/projects/-Users-me-project/%s.jsonl' % A
D_MAIN = '.claude/projects/-Users-me-acme-widgets/%s.jsonl' % D


class Env:
    """A private copy of the fixture home plus a database path."""

    def __init__(self, copy_fixtures=True):
        self.tmp = tempfile.mkdtemp(prefix='recall-test-')
        self.home = os.path.join(self.tmp, 'home')
        if copy_fixtures:
            shutil.copytree(FIXTURES, self.home)
        else:
            os.makedirs(self.home)
        self.db = os.path.join(self.tmp, 'db', 'index.db')

    def cli(self, *args, expect_error=False):
        p = subprocess.run([sys.executable, RECALL, '--db', self.db, '--home', self.home] + list(args),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        text = p.stdout.decode('utf-8')
        lines = [ln for ln in text.splitlines() if ln.strip()]
        if len(lines) != 1:
            raise AssertionError('expected one JSON line, got %r (stderr %r)' % (text, p.stderr))
        out = json.loads(lines[0])
        if expect_error:
            if p.returncode != 1 or 'error' not in out:
                raise AssertionError('expected an error, got %r' % out)
        elif p.returncode != 0 or 'error' in out:
            raise AssertionError('command %r failed: %r %r' % (args, out, p.stderr.decode('utf-8')[-2000:]))
        return out

    def path(self, rel):
        return os.path.join(self.home, rel)

    def sql(self, query, params=()):
        con = sqlite3.connect(self.db)
        try:
            return con.execute(query, params).fetchall()
        finally:
            con.close()

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


def jsonl(path, records, mode='a'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode) as fh:
        for r in records:
            fh.write(json.dumps(r) + '\n')


def iso(ms):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(ms / 1000)) + '.%03dZ' % (ms % 1000)


def rec_user(sid, uuid, text, ts, cwd=PROJ, **kw):
    r = {'type': 'user', 'uuid': uuid, 'sessionId': sid, 'timestamp': ts, 'cwd': cwd, 'isSidechain': False,
         'message': {'role': 'user', 'content': text}}
    r.update(kw)
    return r


def rec_text(sid, uuid, text, ts, cwd=PROJ):
    return {'type': 'assistant', 'uuid': uuid, 'sessionId': sid, 'timestamp': ts, 'cwd': cwd, 'isSidechain': False,
            'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]}}


# ------------------------------------------------------------------------------------------------
# Pure functions

class MaskingTest(unittest.TestCase):
    def secrets(self):
        return {
            'aws_id': 'AKIA' + 'QQQQ' + 'EXAMPLEFAKE1',
            'aws_secret': 'wJal' + 'rXUtnFEMI' + 'K7MDENG' + 'bPxRfiCY' + 'FAKEKEY12345',
            'github': 'gh' + 'p_' + 'Z9' * 18,
            'github_pat': 'github_' + 'pat_' + '1A' * 15,
            'anthropic': 'sk-' + 'ant-' + 'api03-' + 'x7' * 20,
            'openai': 'sk-' + 'proj-' + 'Q1w2E3r4' * 5,
            'slack': 'xo' + 'xb-' + '1234567890-abcdefghij',
            'google': 'AI' + 'za' + 'S' * 35,
            'hf': 'h' + 'f_' + 'k' * 32,
            'gitlab': 'gl' + 'pat-' + 'm' * 20,
            'npm': 'np' + 'm_' + 'n' * 36,
            'stripe': 'sk' + '_live_' + 'r' * 24,
        }

    def test_known_shapes_are_masked(self):
        for name, value in self.secrets().items():
            text = 'the value %s is here' % value
            if name == 'aws_secret':
                text = 'key id %s and secret %s' % (self.secrets()['aws_id'], value)
            out = recall.mask_secrets(text)
            self.assertNotIn(value, out, name)
            self.assertIn('[secret …%s]' % value[-4:], out, name)

    def test_aws_secret_only_near_a_key_id(self):
        forty = 'a' * 20 + 'B' * 20
        self.assertEqual(recall.mask_secrets('just %s here' % forty), 'just %s here' % forty)

    def test_pem_bearer_and_url_credentials(self):
        pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIB' + 'q' * 60 + '\n-----END RSA PRIVATE KEY-----'
        out = recall.mask_secrets('key:\n' + pem + '\nafter')
        self.assertNotIn('qqqqqqqq', out)
        self.assertIn('after', out)
        tok = 'tok' + 'Z' * 30
        self.assertNotIn(tok, recall.mask_secrets('curl -H "Authorization: Bearer %s" x' % tok))
        pw = 'hunter' + '22secret'
        out = recall.mask_secrets('postgres://admin:%s@db.example.com/app' % pw)
        self.assertNotIn(pw, out)
        self.assertIn('postgres://admin:[secret …cret]@db.example.com', out)

    def test_labelled_values(self):
        cases = [
            'password: %s' % ('Hu' + 'nter2Hunter2'),
            'API_KEY=%s' % ('abc' + 'def123456789'),
            '"client_secret": "%s"' % ('s3' + 'cr3tValue99'),
            'wifi password is %s' % ('Corr' + 'ectHorse9'),
            'Client secret:\n  %s' % ('xY' + 'z12345678abc'),
            'export DB_PASSWORD=%s' % ('Zq' + '9xLmN0pQ'),
            'aws_secret_access_key = %s' % ('AbCd' + 'EfGh1234'),
        ]
        for text in cases:
            value = text.split()[-1].strip('"')
            if '=' in value:
                value = value.split('=', 1)[1]
            out = recall.mask_secrets(text)
            self.assertNotIn(value, out, text)
            self.assertIn('[secret …', out, text)

    def test_refs_and_placeholders_are_kept(self):
        for text in ('password: $DB_PASSWORD', 'token = os.environ["GH_TOKEN"]', 'api_key: <your-api-key>',
                     'password: ${PASSWORD}', 'token = get_token()', 'secret = self.secret_value',
                     'the token is required', 'password: ********', 'max_tokens=4096', 'keyboard shortcuts'):
            self.assertEqual(recall.mask_secrets(text), text, text)

    def test_unicode_case_folding_keeps_positions(self):
        value = 'Hu' + 'nter2Hunter2'
        out = recall.mask_secrets('İİİİ notes İ password: %s done' % value)
        self.assertNotIn(value, out)
        self.assertTrue(out.endswith(' done'))

    def test_plain_text_untouched(self):
        text = 'Train the widget model on SF-034 with best_pt.py and commit abc1234.'
        self.assertEqual(recall.mask_secrets(text), text)


class DecisionHeuristicsTest(unittest.TestCase):
    def test_asks(self):
        for t in ('Should I also tune the learning rate?', 'Done. Want me to open a PR?',
                  'Two options:\n(a) ship now\n(b) run a sweep\nWhich do you prefer?',
                  'Option A: keep it. Option B: drop it. Let me know which you want?',
                  'I can do it either way. Do you want me to proceed with the refactor? **'):
            self.assertTrue(recall.is_ask(t), t)
        for t in ('I have updated the file.', 'The tests pass now.', 'Here is the summary: (a) done (b) done.', ''):
            self.assertFalse(recall.is_ask(t), t)

    def test_choice_replies(self):
        for t in ('yes', 'Yes please', 'ok go ahead', '(b) please', 'A', 'b and c', '1 and 2', 'both', 'do it',
                  "let's do the second one", 'no, skip it', "don't", 'go with option 2', 'sounds good', 'LGTM',
                  'approved'):
            self.assertTrue(recall.is_choice_reply(t), t)
        for t in ('a better approach is to cache', 'Actually can you explain the cache first?', '', 'x' * 300,
                  'why did the build fail', '2 weeks ago it worked differently, look into it'):
            self.assertFalse(recall.is_choice_reply(t), t)

    def test_decision_sentences(self):
        positives = ["We will use Postgres for the widget store.", "We are not going to use Redis.",
                     "Let's go with the gadget API v2.", 'We definitely need retries.',
                     'For now, we can skip the migration.', 'Make dark mode the default.',
                     'MIT license is fine for this repo.', 'Use pnpm instead of npm.',
                     'The flaky test is not a blocker.', 'Approved, ship it.', 'I want to state that the API is frozen.',
                     "We're going to use the cosine schedule."]
        for t in positives:
            self.assertEqual(recall.decision_sentences(t), [t], t)
        self.assertEqual(recall.decision_sentences('Example:\n```\nWe will use Redis.\n```\nok'), [])
        self.assertEqual(recall.decision_sentences('    We will use Redis.'), [])
        negatives = ['Is the MIT license fine?', 'It is fine.', 'That is fine.', 'We used to go with yarn.',
                     'Can you fine-tune the model?', 'The model is fine-tuned on widgets.', 'Please check the logs.',
                     'Should we use Postgres?', 'Which one is fine?',
                     'So when submitting specs, if the specs are approved the finish task cannot continue.',
                     'Approve the pending reviews in the dashboard.', 'Once we go with the new API we can refactor.']
        for t in negatives:
            self.assertEqual(recall.decision_sentences(t), [], t)

    def test_ask_decision_text(self):
        out = recall.ask_decision('x' * 500 + ' Should I ship it?', 'yes')
        self.assertTrue(out.startswith('Q: …'))
        self.assertTrue(out.endswith('Should I ship it? → A: yes'))


class TextTest(unittest.TestCase):
    def test_clean_human(self):
        text = ('<system-reminder>hidden</system-reminder>\n<command-name>/review</command-name>\n'
                '<command-message>review</command-message>\n<command-args>src/app.py</command-args>')
        clean, typed, bash = recall.clean_human(text)
        self.assertEqual(clean, '/review src/app.py')
        self.assertEqual(bash, [])
        clean, typed, bash = recall.clean_human('<bash-input>ls</bash-input>')
        self.assertEqual((clean, bash), ('', ['ls']))
        body = 'line\n' * 1000
        clean, typed, _ = recall.clean_human('See <pasted_content id="1">\n%s</pasted_content id="1"> now' % body)
        self.assertIn('…[pasted, ', clean)
        self.assertLess(len(clean), 1400)
        self.assertNotIn('line', typed)
        self.assertNotIn('pasted_content', clean)

    def test_chunking(self):
        paras = ['Paragraph %d. ' % i + 'word ' * 60 for i in range(30)]
        chunks = recall.chunk_text('\n\n'.join(paras))
        self.assertGreater(len(chunks), 3)
        self.assertTrue(all(len(c) <= recall.CHUNK_CHARS + 300 for c in chunks))
        self.assertEqual(' '.join(' '.join(chunks).split()), ' '.join('\n\n'.join(paras).split()))
        self.assertEqual(recall.chunk_text('short'), ['short'])
        self.assertTrue(all(len(c) <= recall.CHUNK_CHARS + 300 for c in recall.chunk_text('x' * 10000)))

    def test_commit_message(self):
        cm = recall.commit_message
        self.assertEqual(cm('git add -A && git commit -q -m "Fix the widget" -m "Body" && git push'),
                         'Fix the widget\n\nBody')
        self.assertEqual(cm("git commit -q -F - <<'EOF'\nSubject\n\nBody\nEOF"), 'Subject\n\nBody')
        self.assertEqual(cm('git commit -m "$(cat <<\'EOF\'\nHeredoc subject\nEOF\n)"'), 'Heredoc subject')
        self.assertEqual(cm('git -C /x commit --message="Long form"'), 'Long form')
        self.assertEqual(cm("git commit -qm 'Single quoted'"), 'Single quoted')
        self.assertEqual(cm('git log --format=commit'), '')

    def test_times(self):
        self.assertEqual(recall.ts_ms('2026-09-01T09:00:30.000Z'), 1788253230000)
        self.assertEqual(recall.ts_ms('2026-09-01T11:00:30+02:00'), 1788253230000)
        self.assertEqual(recall.ts_ms(1788253230), 1788253230000)
        self.assertIsNone(recall.ts_ms('not a time'))
        now = recall.now_ms()
        self.assertAlmostEqual(recall.parse_time('7d'), now - 7 * 86400000, delta=5000)
        self.assertLess(recall.parse_time('2026-09-01'), recall.parse_time('2026-09-01', end=True))
        with self.assertRaises(recall.RecallError):
            recall.parse_time('soonish')

    def test_parts(self):
        self.assertEqual(recall.parts_of('see my-project and best_pt.py'), 'my project best pt')
        self.assertEqual(recall.parts_of('gh repo edit --delete-branch-on-merge'),
                         'delete-branch-on-merge delete branch on merge')
        self.assertEqual(recall.parts_of('plain words only'), '')


class QueryParsingTest(unittest.TestCase):
    def test_terms_phrases_or_not_filters(self):
        q = recall.parse_query('widget "cosine schedule" gadget OR gizmo -legacy project:widgets kind:decision since:7d')
        self.assertEqual(q.filters, {'project': 'widgets', 'kind': 'decision', 'since': '7d'})
        self.assertEqual(recall.match_expr(q), '("widget" AND "cosine schedule" AND ("gadget" OR "gizmo")) NOT ("legacy")')

    def test_prefix_and_junk(self):
        q = recall.parse_query('widg* * - " ""')
        self.assertEqual(recall.match_expr(q), '"widg"*')
        self.assertIsNone(recall.match_expr(recall.parse_query('AND OR NOT')))
        self.assertEqual(recall.match_expr(recall.parse_query('say "hi')), '"say" AND "hi"')


# ------------------------------------------------------------------------------------------------
# The fixture corpus, indexed once with subagents

class FixtureCorpusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = Env()
        cls.update = cls.env.cli('update', '--subagents')
        cls.note = cls.env.cli('note', 'add', '--text', 'Remember: zanzibar is the queue we picked for widgets.',
                               '--project', 'project')

    @classmethod
    def tearDownClass(cls):
        cls.env.close()

    def docs(self, where='1', params=()):
        return self.env.sql('SELECT kind, text, extra, session_id, sub, role FROM docs_all WHERE ' + where, params)

    def texts(self, kind=None, session=None):
        q, p = 'SELECT text FROM docs_all WHERE 1', []
        if kind:
            q += ' AND kind=?'
            p.append(kind)
        if session:
            q += ' AND session_id=?'
            p.append(session)
        return [r[0] for r in self.env.sql(q, p)]

    def search(self, *args):
        return self.env.cli('search', *args)

    # -- update output and stats --------------------------------------------------------------
    def test_update_shape(self):
        u = self.update['updated']
        self.assertEqual(set(u), {'files', 'docs_added', 'docs_removed', 'sessions', 'seconds', 'partial'})
        self.assertFalse(u['partial'])
        self.assertGreater(u['docs_added'], 50)
        st = self.update['stats']
        for key in ('db', 'bytes', 'sessions', 'docs', 'byKind', 'bySource', 'oldest', 'newest', 'lastUpdate',
                    'transcriptsDeleted', 'routineSessions'):
            self.assertIn(key, st)
        self.assertEqual(st['sessions'], 5)
        self.assertEqual(st['routineSessions'], 1)

    def test_stats_command(self):
        st = self.env.cli('stats')
        self.assertEqual(st['db'], self.env.db)
        self.assertGreater(st['bytes'], 0)
        self.assertEqual(st['docs'], sum(st['byKind'].values()))
        self.assertIn('codex', st['bySource'])

    def test_db_permissions(self):
        self.assertEqual(os.stat(os.path.dirname(self.env.db)).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.env.db).st_mode & 0o777, 0o600)

    # -- extraction ---------------------------------------------------------------------------
    def test_prompts_are_cleaned(self):
        prompts = self.texts('prompt', A)
        joined = '\n'.join(prompts)
        self.assertIn('Please train the widget model on the new dataset and report the accuracy.', prompts)
        self.assertIn('/model opus', prompts)
        self.assertIn('QUEUEDMARK also export the widget metrics to csv', prompts)
        self.assertIn('PASTEDMARK', joined)
        self.assertIn('…[pasted, ', joined)
        for mark in ('REMINDERMARK', 'LOCALSTDOUTMARK', 'META_SKIP_MARK', 'HOOKMARK', 'BASHSTDOUTMARK',
                     'pasted_content', 'command-name', 'system-reminder'):
            self.assertNotIn(mark, joined, mark)
        all_text = '\n'.join(self.texts())
        for mark in ('THINKINGMARK', 'REMINDERMARK', 'META_SKIP_MARK', 'HOOKMARK', 'DEVMARK', 'AGENTSMARK', 'ENVMARK',
                     'REASONINGMARK', 'EVENTMARK', 'GUARDIANMARK', 'JOURNALMARK'):
            self.assertNotIn(mark, all_text, mark)

    def test_bash_input_and_commands(self):
        rows = self.docs("kind='command' AND session_id=?", (A,))
        texts = [r[1] for r in rows]
        self.assertIn('ls -la data/widgets', texts)
        self.assertTrue(any(t.startswith('python train.py --epochs 3') and 'Train the widget model' in t for t in texts))
        failed = [json.loads(r[2]) for r in rows if r[1].startswith('pytest tests/test_widget.py')]
        self.assertEqual(len(failed), 1)
        self.assertIn('AssertionError', failed[0]['error'])
        self.assertEqual(failed[0]['exit'], 1)

    def test_answers_summary_title(self):
        answers = self.texts('answer', A)
        self.assertTrue(any(t.startswith('All done: the widget model is trained') for t in answers))
        summaries = self.texts('summary', A)
        self.assertEqual(len(summaries), 1)
        self.assertIn('COMPACTMARK', summaries[0])
        self.assertFalse(summaries[0].startswith('This session is being continued'))
        self.assertEqual(self.texts('title', A), ['Widget model training'])
        self.assertEqual(self.env.sql('SELECT title FROM sessions WHERE session_id=?', (A,))[0][0],
                         'Widget model training')

    def test_notification_summary_is_low_weight_answer(self):
        rows = self.docs("role='notification'")
        self.assertEqual(len(rows), 1)
        self.assertIn('Run the widget benchmark suite', rows[0][1])

    def test_commits_prs_issues(self):
        commits = {json.loads(r[2])['sha']: r[1] for r in self.docs("kind='commit'")}
        self.assertEqual(commits['abc1234'], 'Train the widget model with augmentation\n\nAdds random flips to the loader.')
        self.assertEqual(commits['def5678'], 'Fix widget shape bug')
        self.assertEqual(commits['9fe8a7b'], 'Stream the gadget parser')
        prs = self.docs("kind='pr'")
        self.assertEqual(len(prs), 1)
        e = json.loads(prs[0][2])
        self.assertEqual((e['number'], e['url'], e['title'], e['repo']),
                         (12, 'https://github.com/acme/widgets/pull/12', 'Widget model training', 'acme/widgets'))
        issues = self.docs("kind='issue'")
        self.assertEqual(len(issues), 1)
        self.assertEqual(json.loads(issues[0][2])['title'], 'Widget accuracy regression')

    def test_files_urls_tasks(self):
        files = {json.loads(r[2])['path']: json.loads(r[2])['edits'] for r in self.docs("kind='file' AND session_id=?", (A,))}
        self.assertEqual(files, {PROJ + '/src/widget.py': 2, PROJ + '/tests/test_widget.py': 1})
        urls = self.texts('url', A)
        self.assertTrue(any(u.startswith('https://example.com/docs/widgets') for u in urls))
        self.assertIn('widget model learning rate schedule', urls)
        tasks = {json.loads(r[2]).get('subject'): json.loads(r[2])['status'] for r in self.docs("kind='task' AND session_id=?", (A,))}
        self.assertEqual(tasks, {'Retrain the widget model': 'completed', 'Write the widget report': 'pending',
                                 'Plot the confusion matrix': 'completed', 'Upload the widget weights': 'pending'})

    def test_decisions(self):
        a = self.texts('decision', A)
        self.assertIn('We will use the cosine schedule for the widget model.', a)
        self.assertIn('The flaky widget test is not a blocker.', a)
        self.assertIn('Q: Which dataset should I use? → A: The cleaned one', a)
        reply = [t for t in a if t.startswith('Q: The model reached 0.91 accuracy.')]
        self.assertEqual(len(reply), 1)
        self.assertTrue(reply[0].endswith('→ A: (b) please'))
        d = self.texts('decision', D)
        self.assertEqual(sorted(d), sorted([
            "Let's go with the gadget API v2.", 'MIT license is fine for this repo.', 'Use pnpm instead of npm.',
            'Make dark mode the default.', 'For now, we can skip the migration.', 'We definitely need retries.',
            'I want to state that the public API is frozen.', 'Approved, ship it.',
            'We will use zanzibar for the widget queue.']))
        self.assertEqual(self.texts('decision', C), [])  # routine prompts never make decisions

    def test_routine_session(self):
        rows = self.env.sql('SELECT routine, routine_name FROM sessions WHERE session_id=?', (C,))
        self.assertEqual(rows, [(1, 'nightly-widget-check')])
        out = self.search('--query', 'ROUTINEMARK', '--routines', 'exclude')
        self.assertEqual(out['hits'], [])
        out = self.search('--query', 'ROUTINEMARK')
        self.assertEqual(len(out['hits']), 1)
        self.assertEqual(self.search('--query', 'ROUTINEMARK routines:exclude')['hits'], [])
        only = self.search('--query', 'widget routines:only')
        self.assertTrue(only['hits'] and all(h['session'] == C for h in only['hits']))
        tl = self.env.cli('timeline', '--since', '2026-08-01', '--routines', 'exclude')
        self.assertNotIn(C, [s['session'] for day in tl['days'] for s in day['sessions']])
        rc = self.env.cli('recap', '--project', 'project', '--count', '5', '--routines', 'exclude')
        self.assertNotIn(C, [s['session'] for s in rc['sessions']])
        rc = self.env.cli('recap', '--project', 'project', '--count', '5')
        self.assertIn(C, [s['session'] for s in rc['sessions']])

    def test_subagents(self):
        rows = self.docs('sub > 0')
        sessions = {r[3] for r in rows}
        self.assertEqual(sessions, {A, CX, D})  # Claude subagents, a Codex spawned thread, a sidechain record
        reports = [r for r in rows if r[4] == 2]
        self.assertEqual(sorted(r[1].split()[-1] for r in reports),
                         ['CODEXSUBREPORT', 'SUBAGENTREPORTMARK', 'WORKFLOWREPORTMARK'])
        prompts = self.env.sql('SELECT prompt_count FROM sessions WHERE session_id=?', (A,))[0][0]
        self.assertEqual(prompts, 7)  # subagent prompts are not the human's
        hit = self.search('--query', 'SUBAGENTREPORTMARK')['hits'][0]
        self.assertEqual(hit['session'], A)
        self.assertTrue(hit['extra']['subagent'])
        self.assertTrue(hit['extra']['report'])
        self.assertEqual(hit['extra']['agent'], 'Map widget training code (Explore)')
        wf = self.search('--query', 'WORKFLOWREPORTMARK')['hits'][0]
        self.assertEqual(wf['extra']['agent'], 'research: widgets')
        # sessions listings never show subagents as sessions of their own
        self.assertEqual(self.env.sql('SELECT COUNT(*) FROM sessions')[0][0], 5)
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM sessions WHERE session_id=?", (CG,))[0][0], 0)

    def test_subagent_weight(self):
        env = Env(copy_fixtures=False)
        try:
            sid = 'bbbbbbbb-0000-4000-8000-000000000001'
            same = 'The gizmo cache warms up in five seconds after a restart of the widget service.'
            jsonl(os.path.join(env.home, '.claude/projects/-Users-me-project', sid + '.jsonl'),
                  [rec_user(sid, 'p1', 'How fast does the gizmo cache warm up?', '2026-09-09T10:00:00.000Z'),
                   rec_text(sid, 'p2', same, '2026-09-09T10:00:10.000Z')])
            sub = os.path.join(env.home, '.claude/projects/-Users-me-project', sid, 'subagents', 'agent-x1.jsonl')
            twin = same.replace('widget', 'gadget')  # same length and matched terms, not a duplicate
            jsonl(sub, [rec_user(sid, 'q1', 'Measure the gizmo cache warm-up.', '2026-09-09T10:00:01.000Z'),
                        rec_text(sid, 'q2', twin, '2026-09-09T10:00:02.000Z'),
                        rec_text(sid, 'q3', 'Final report: ' + same, '2026-09-09T10:00:03.000Z')])
            env.cli('update', '--subagents')
            hits = env.cli('search', '--query', 'gizmo cache warms', '--limit', '5', '--kinds', 'answer')['hits']
            self.assertEqual(len(hits), 3)
            main = [h for h in hits if not h['extra'].get('subagent')][0]
            middle = [h for h in hits if h['extra'].get('subagent') and not h['extra'].get('report')][0]
            report = [h for h in hits if h['extra'].get('report')][0]
            self.assertEqual(hits[-1]['ref'], middle['ref'])
            self.assertAlmostEqual(middle['score'] / main['score'], 0.6, delta=0.05)
            self.assertGreater(report['score'], middle['score'])
            self.assertEqual(env.sql('SELECT prompt_count FROM sessions')[0][0], 1)
        finally:
            env.close()

    def test_duplicate_session_copies_are_deduplicated(self):
        rows = self.env.sql("SELECT COUNT(*) FROM docs_all WHERE text LIKE 'Please train the widget model%'")
        self.assertEqual(rows[0][0], 1)
        cmds = self.env.sql("SELECT COUNT(*) FROM docs_all WHERE text LIKE 'python train.py%'")
        self.assertEqual(cmds[0][0], 1)

    def test_worktree_groups_with_repo(self):
        self.assertEqual(self.env.sql('SELECT project FROM sessions WHERE session_id=?', (B,)), [(PROJ,)])
        projects = {p['key']: p for p in self.env.cli('projects')['projects']}
        self.assertIn(PROJ, projects)
        self.assertIn(ACME, projects)
        self.assertEqual(projects[PROJ]['name'], 'project')
        self.assertEqual(projects[PROJ]['sessions'], 3)
        self.assertIn('/Users/me/project/.claude/worktrees/feature-x', projects[PROJ]['paths'])
        for p in projects.values():
            self.assertEqual(set(p), {'key', 'name', 'paths', 'sessions', 'lastTs'})

    def test_codex_session(self):
        row = self.env.sql('SELECT source, project, title, branch, prompt_count FROM sessions WHERE session_id=?', (CX,))
        self.assertEqual(row, [('codex', ACME, 'Gadget parser streaming', 'main', 1)])
        self.assertEqual(self.texts('prompt', CX)[0], 'Refactor the gadget parser to stream its input.')
        err = [json.loads(r[2]) for r in self.docs("kind='command' AND session_id=? AND text LIKE 'pytest%'", (CX,))]
        self.assertEqual(err[0]['exit'], 1)
        self.assertEqual(self.texts('file', CX), [ACME + '/src/gadget.py'])
        self.assertEqual(self.texts('url', CX), ['python streaming json parser'])
        tasks = {json.loads(r[2])['subject']: json.loads(r[2])['status'] for r in self.docs("kind='task' AND session_id=?", (CX,))}
        self.assertEqual(tasks, {'Write streaming tests': 'completed', 'Document the gadget API': 'pending'})
        out = self.search('--query', 'gadget parser', '--source', 'codex')
        self.assertTrue(out['hits'] and all(h['source'] == 'codex' for h in out['hits']))
        self.assertEqual(self.env.cli('expand', '--ref', out['hits'][0]['ref'])['session']['resume'], 'codex resume ' + CX)

    def test_memory_orders_reviews(self):
        mem = self.docs("kind='memory' AND text LIKE '%MEMORYMARK%'")
        self.assertEqual(len(mem), 1)
        self.assertEqual(self.env.sql("SELECT project FROM docs_all WHERE kind='memory' AND text LIKE '%MEMORYMARK%'"),
                         [(PROJ,)])
        hit = self.search('--query', 'MEMORYMARK')['hits'][0]
        self.assertEqual((hit['kind'], hit['projectName'], hit['title']), ('memory', 'project', 'widget-training'))
        order = self.search('--query', 'ORDERMARK')['hits'][0]
        self.assertEqual((order['kind'], order['projectName'], order['ts']), ('order', 'project', 1788000000000))
        review = self.search('--query', 'REVIEWMARK')['hits'][0]
        self.assertEqual((review['kind'], review['project'], review['title']),
                         ('review', PROJ, 'Second opinion: the widget trainer'))
        self.assertEqual(review['ts'], recall.ts_ms('2026-09-03T10:00:00Z'))
        by_name = self.search('--query', 'REVIEWTWOMARK')['hits'][0]
        self.assertEqual(by_name['project'], ACME)
        self.assertEqual(recall.second_opinion_key('/Users/me/project'), 'project-0i6491r')
        self.assertEqual(recall.second_opinion_key('/Users/me/acme/widgets/'), 'widgets-0uwqk0a')

    # -- search ----------------------------------------------------------------------------------
    def test_search_shape_and_snippets(self):
        out = self.search('--query', 'cosine schedule', '--limit', '5')
        self.assertEqual(set(out), {'query', 'total', 'hits', 'sessions'})
        self.assertEqual(out['query'], 'cosine schedule')
        self.assertGreaterEqual(out['total'], len(out['hits']))
        self.assertTrue(out['hits'])
        for h in out['hits']:
            self.assertEqual(set(h), {'ref', 'session', 'project', 'projectName', 'title', 'ts', 'kind', 'role',
                                      'source', 'snippet', 'score', 'extra'})
            self.assertRegex(h['ref'], r'^d\d+$')
            self.assertLessEqual(len(h['snippet']), 240)
            self.assertIn('[[', h['snippet'])
        for s in out['sessions']:
            self.assertEqual(set(s), {'session', 'title', 'projectName', 'hits', 'lastTs', 'transcriptExists'})
        scores = [h['score'] for h in out['hits']]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_whole_tokens_and_pieces(self):
        # `test_widget` and `learning-rate` are single tokens (tokenchars '-_')...
        whole = self.search('--query', 'test_widget', '--kinds', 'file')['hits']
        self.assertEqual([h['snippet'] for h in whole], ['/Users/me/project/tests/[[test_widget]].py'])
        lr = self.search('--query', 'learning-rate', '--kinds', 'answer')['hits']
        snippets = ' '.join(h['snippet'] for h in lr)
        self.assertIn('[[learning-rate]]', snippets)  # the whole token...
        self.assertIn('learning rate', snippets.replace('[[', '').replace(']]', ''))  # ...and the phrase of its pieces
        # ...and their pieces still find them (the `parts` column), highlighted in Python
        files = self.search('--query', 'widget', '--kinds', 'file', '--limit', '10')['hits']
        self.assertIn(whole[0]['ref'], [h['ref'] for h in files])
        piece = [h for h in files if h['ref'] == whole[0]['ref']][0]
        self.assertIn('[[widget]]', piece['snippet'])
        self.assertEqual(self.search('--query', 'learning-ra')['hits'], [])  # whole tokens, not substrings
        self.assertTrue(self.search('--query', 'learning*')['hits'])         # unless asked for a prefix
        wt = self.search('--query', 'feature-x')['hits']
        self.assertTrue(wt and all(h['session'] == B for h in wt))
        self.assertTrue(self.search('--query', 'exporter.py')['hits'])

    def test_ranking_note_decision_answer(self):
        out = self.search('--query', 'zanzibar', '--limit', '10')
        kinds = [h['kind'] for h in out['hits']]
        self.assertEqual(kinds[0], 'note')
        self.assertLess(kinds.index('decision'), kinds.index('answer'))

    def test_filters(self):
        out = self.search('--query', 'widget project:widgets')
        self.assertTrue(out['hits'])
        self.assertTrue(all(h['projectName'] in ('widgets', None) for h in out['hits']))
        out = self.search('--query', 'widget', '--project', PROJ, '--kinds', 'command,file')
        self.assertTrue(out['hits'] and all(h['kind'] in ('command', 'file') for h in out['hits']))
        out = self.search('--query', 'widget kind:decision')
        self.assertTrue(out['hits'] and all(h['kind'] == 'decision' for h in out['hits']))
        out = self.search('--query', 'widget session:%s' % B)
        self.assertTrue(out['hits'] and all(h['session'] == B for h in out['hits']))
        out = self.search('--query', 'widget', '--exclude-session', A, '--limit', '30')
        self.assertTrue(all(h['session'] != A for h in out['hits']))
        out = self.search('--query', 'widget since:2026-09-04')
        self.assertTrue(all(h['ts'] >= recall.parse_time('2026-09-04') for h in out['hits']))
        out = self.search('--query', 'widget', '--until', '2026-09-01')
        self.assertTrue(out['hits'] and all(h['ts'] < recall.parse_time('2026-09-01', end=True) for h in out['hits']))
        self.assertEqual(self.search('--query', 'widget project:nosuchproject')['hits'], [])
        # filters in the query override flags
        out = self.search('--query', 'gadget source:codex', '--source', 'claude')
        self.assertTrue(out['hits'] and all(h['source'] == 'codex' for h in out['hits']))
        # boost a project: its hits score 1.5x
        plain = {h['ref']: h for h in self.search('--query', 'gadget exporter', '--limit', '20')['hits']}
        boosted = {h['ref']: h for h in self.search('--query', 'gadget exporter', '--limit', '20',
                                                     '--boost-project', 'project')['hits']}
        for ref, h in boosted.items():
            ratio = h['score'] / plain[ref]['score']
            self.assertAlmostEqual(ratio, 1.5 if h['projectName'] == 'project' else 1.0, delta=0.01)

    def test_filter_only_and_negation(self):
        out = self.search('--query', 'kind:decision project:widgets')
        self.assertTrue(out['hits'] and all(h['kind'] == 'decision' for h in out['hits']))
        out = self.search('--query', 'widget -gadget', '--limit', '30')
        self.assertTrue(out['hits'])
        for h in out['hits']:
            text = self.env.sql('SELECT text FROM docs_all WHERE id=?', (int(h['ref'][1:]),))[0][0]
            self.assertNotIn('gadget', text.lower())

    def test_query_escaping_never_errors(self):
        for q in ('"unbalanced', 'AND OR NOT', '*', '-', 'foo(bar)[baz]{}:;\'', 'NEAR(widget', '^widget',
                  'col:value', '"', "'", '\\', 'widget AND', 'OR widget', 'NOT', '- -', 'a"b"c', 'kind:',
                  '***widget***', '-"phrase only"', 'widget OR OR gadget', '{}', 'ünïcödé', '🙂', 'x' * 500):
            out = self.search('--query', q)
            self.assertIn('hits', out, q)
        self.assertTrue(self.search('--query', '"unbalanced widget')['hits'] is not None)
        self.assertTrue(self.search('--query', 'SF-034 OR widget')['hits'])

    # -- expand, recap, timeline, list ------------------------------------------------------
    def test_expand(self):
        hit = self.search('--query', 'cosine schedule kind:decision')['hits'][0]
        out = self.env.cli('expand', '--ref', hit['ref'], '--before', '2', '--after', '2')
        self.assertEqual(set(out), {'session', 'focus', 'items'})
        self.assertEqual(out['focus'], hit['ref'])
        s = out['session']
        self.assertEqual(set(s) - {'agent'}, {'session', 'title', 'project', 'projectName', 'start', 'end', 'source',
                                             'resume', 'transcriptExists', 'transcriptPath'})
        self.assertEqual(s['resume'], 'claude --resume ' + A)
        self.assertTrue(s['transcriptExists'])
        refs = [i['ref'] for i in out['items']]
        self.assertIn(hit['ref'], refs)
        self.assertLessEqual(len(refs), 5)
        for i in out['items']:
            self.assertTrue({'ref', 'ts', 'kind', 'role', 'text'} <= set(i))
            self.assertIn(i['kind'], recall.EXPAND_KINDS)
        ts = [i['ts'] for i in out['items']]
        self.assertEqual(ts, sorted(ts))
        for budget in ('200', '300', '1000'):
            small = self.env.cli('expand', '--ref', hit['ref'], '--max-chars', budget, '--before', '8', '--after', '8')
            self.assertLessEqual(sum(len(i['text']) for i in small['items']), int(budget))
            self.assertIn(hit['ref'], [i['ref'] for i in small['items']])
        sub = self.search('--query', 'SUBAGENTREPORTMARK')['hits'][0]
        items = self.env.cli('expand', '--ref', sub['ref'])['items']
        self.assertTrue(all(i.get('subagent') for i in items))
        self.env.cli('expand', '--ref', 'd999999', expect_error=True)
        self.env.cli('expand', '--ref', 'nonsense', expect_error=True)

    def test_recap(self):
        out = self.env.cli('recap', '--session', A)
        self.assertEqual(len(out['sessions']), 1)
        r = out['sessions'][0]
        self.assertEqual(set(r), {'session', 'title', 'projectName', 'start', 'end', 'prompts', 'routine', 'firstPrompt',
                                  'lastPrompts', 'lastAnswer', 'commits', 'prs', 'issues', 'files', 'openTasks',
                                  'decisions', 'resume', 'transcriptExists'})
        self.assertEqual(r['title'], 'Widget model training')
        self.assertEqual(r['prompts'], 7)
        self.assertFalse(r['routine'])
        self.assertTrue(r['firstPrompt'].startswith('Please train the widget model'))
        self.assertEqual(len(r['lastPrompts']), 3)
        self.assertEqual(r['lastPrompts'][-1], 'Mention zanzibar in the final report too.')
        self.assertTrue(r['lastAnswer'].startswith('All done: the widget model is trained'))
        self.assertIn({'sha': 'abc1234', 'message': 'Train the widget model with augmentation'}, r['commits'])
        self.assertEqual(r['prs'], [{'number': 12, 'url': 'https://github.com/acme/widgets/pull/12',
                                     'title': 'Widget model training'}])
        self.assertEqual(r['issues'][0]['number'], 34)
        self.assertEqual(r['files'][0], PROJ + '/src/widget.py')
        self.assertEqual(sorted(r['openTasks']), ['Upload the widget weights', 'Write the widget report'])
        self.assertLessEqual(len(r['decisions']), 5)
        self.assertEqual(r['resume'], 'claude --resume ' + A)
        latest = self.env.cli('recap', '--project', 'project', '--exclude-session', C)['sessions']
        self.assertEqual(len(latest), 1)
        self.assertNotEqual(latest[0]['session'], C)
        self.assertEqual(self.env.cli('recap', '--project', 'nosuch')['sessions'], [])
        self.env.cli('recap', '--session', 'nope', expect_error=True)

    def test_timeline(self):
        out = self.env.cli('timeline', '--since', '2026-08-01')
        self.assertTrue(out['days'])
        dates = [d['date'] for d in out['days']]
        self.assertEqual(dates, sorted(dates, reverse=True))
        sessions = [s for d in out['days'] for s in d['sessions']]
        self.assertEqual({s['session'] for s in sessions}, {A, B, C, D, CX})
        for s in sessions:
            self.assertEqual(set(s), {'session', 'title', 'projectName', 'start', 'end', 'prompts', 'commits', 'prs',
                                      'routine', 'source'})
        a = [s for s in sessions if s['session'] == A][0]
        self.assertEqual((a['commits'], a['prs']), (2, 1))
        only = self.env.cli('timeline', '--since', '2026-08-01', '--project', 'widgets')
        self.assertEqual({s['session'] for d in only['days'] for s in d['sessions']}, {D, CX})

    def test_list(self):
        out = self.env.cli('list', '--kind', 'decision', '--project', 'widgets', '--limit', '3')
        self.assertEqual(len(out['items']), 3)
        for i in out['items']:
            self.assertEqual(set(i), {'ref', 'ts', 'session', 'projectName', 'title', 'kind', 'text', 'extra'})
            self.assertEqual(i['kind'], 'decision')
        ts = [i['ts'] for i in out['items']]
        self.assertEqual(ts, sorted(ts, reverse=True))
        out = self.env.cli('list', '--kind', 'commit', '--query', 'widget')
        self.assertEqual({i['extra']['sha'] for i in out['items']}, {'abc1234', 'def5678'})
        for kind in ('command', 'file', 'pr', 'issue', 'url', 'note', 'task', 'order', 'review'):
            self.assertTrue(self.env.cli('list', '--kind', kind)['items'], kind)
        self.env.cli('list', '--kind', 'bogus', expect_error=True)

    def test_errors_are_json(self):
        self.env.cli('nosuchcommand', expect_error=True)
        self.env.cli('search', expect_error=True)
        self.env.cli('search', '--query', 'x', '--since', 'whenever', expect_error=True)
        self.env.cli('forget', expect_error=True)
        self.env.cli('update', '--sources', 'nope', expect_error=True)


class NotesTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.cli('update', '--subagents')

    def tearDown(self):
        self.env.close()

    def test_note_add_list_forget_and_survive_rebuild(self):
        n = self.env.cli('note', 'add', '--text', 'The quokka cache must stay under 2 GB.', '--project', 'widgets')
        self.assertEqual(set(n['note']), {'ref', 'ts', 'projectName', 'text'})
        self.assertEqual(n['note']['projectName'], 'widgets')
        g = self.env.cli('note', 'add', '--text', 'A global quokka note.')
        self.assertIsNone(g['note']['projectName'])
        items = self.env.cli('note', 'list', '--project', 'widgets')['items']
        self.assertEqual([i['ref'] for i in items], [g['note']['ref'], n['note']['ref']])  # global notes show everywhere
        self.assertEqual(len(self.env.cli('note', 'list')['items']), 2)
        self.env.cli('update', '--subagents', '--rebuild')
        hits = self.env.cli('search', '--query', 'quokka')['hits']
        self.assertEqual({h['ref'] for h in hits}, {n['note']['ref'], g['note']['ref']})
        self.assertEqual(self.env.cli('note', 'forget', '--ref', n['note']['ref']), {'forgotten': 1})
        self.assertEqual(self.env.cli('note', 'forget', '--ref', n['note']['ref']), {'forgotten': 0})
        self.assertEqual(len(self.env.cli('note', 'list', '--project', 'widgets')['items']), 1)
        other = self.env.cli('search', '--query', 'gadget')['hits'][0]['ref']
        self.env.cli('note', 'forget', '--ref', other, expect_error=True)


class NoSubagentsTest(unittest.TestCase):
    def test_subagents_and_sidechains_excluded(self):
        env = Env()
        try:
            env.cli('update')
            self.assertEqual(env.sql('SELECT COUNT(*) FROM docs_all WHERE sub > 0')[0][0], 0)
            all_text = '\n'.join(r[0] for r in env.sql('SELECT text FROM docs_all'))
            for mark in ('SUBAGENTREPORTMARK', 'WORKFLOWREPORTMARK', 'SIDECHAINMARK', 'CODEXSUBMARK'):
                self.assertNotIn(mark, all_text)
            self.assertEqual(env.sql("SELECT COUNT(*) FROM files WHERE kind='sub'")[0][0], 0)
            # turning subagents on later picks them up incrementally (Claude files and Codex spawned threads)
            out = env.cli('update', '--subagents')
            self.assertGreater(out['updated']['docs_added'], 0)
            all_text = '\n'.join(r[0] for r in env.sql('SELECT text FROM docs_all'))
            for mark in ('SUBAGENTREPORTMARK', 'WORKFLOWREPORTMARK', 'SIDECHAINMARK', 'CODEXSUBMARK'):
                self.assertIn(mark, all_text)
            self.assertNotIn('GUARDIANMARK', all_text)
        finally:
            env.close()


# ------------------------------------------------------------------------------------------------
# Incremental behaviour (each test has its own copy)

class IncrementalTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.first = self.env.cli('update', '--subagents')

    def tearDown(self):
        self.env.close()

    def ids(self, session):
        return {r[0] for r in self.env.sql('SELECT id FROM docs_all WHERE session_id=?', (session,))}

    def test_second_update_is_a_no_op(self):
        out = self.env.cli('update', '--subagents')['updated']
        self.assertEqual((out['files'], out['docs_added'], out['docs_removed']), (0, 0, 0))

    def test_append_only_reads_new_lines(self):
        before = self.ids(D)
        path = self.env.path(D_MAIN)
        jsonl(path, [rec_user(D, 'd-new-1', 'Please add a gizmo endpoint to the widgets API.', '2026-09-05T10:00:00.000Z', ACME),
                     rec_text(D, 'd-new-2', 'I added the gizmo endpoint with validation and two tests for it.',
                              '2026-09-05T10:01:00.000Z', ACME)])
        out = self.env.cli('update', '--subagents')['updated']
        self.assertEqual(out['files'], 1)
        self.assertEqual(out['docs_added'], 2)
        self.assertEqual(out['docs_removed'], 0)
        after = self.ids(D)
        self.assertTrue(before < after)
        self.assertEqual(len(after - before), 2)
        self.assertEqual(self.env.sql('SELECT prompt_count, last_ts FROM sessions WHERE session_id=?', (D,))[0],
                         (8, recall.ts_ms('2026-09-05T10:01:00.000Z')))

    def test_partial_line_waits_for_its_end(self):
        path = self.env.path(D_MAIN)
        line = json.dumps(rec_user(D, 'd-part', 'Half written gizmo prompt that arrives in two writes.',
                                   '2026-09-05T11:00:00.000Z', ACME))
        with open(path, 'a') as fh:
            fh.write(line[:40])
        self.assertEqual(self.env.cli('update')['updated']['docs_added'], 0)
        with open(path, 'a') as fh:
            fh.write(line[40:] + '\n')
        self.assertEqual(self.env.cli('update')['updated']['docs_added'], 1)
        self.assertEqual(len(self.env.cli('search', '--query', '"Half written gizmo"')['hits']), 1)

    def test_tool_result_in_a_later_update(self):
        path = self.env.path(D_MAIN)
        jsonl(path, [{'type': 'assistant', 'uuid': 'd-t1', 'sessionId': D, 'timestamp': '2026-09-05T12:00:00.000Z',
                      'cwd': ACME, 'message': {'role': 'assistant', 'content': [
                          {'type': 'tool_use', 'id': 'toolu_late', 'name': 'Bash',
                           'input': {'command': 'git commit -m "Late gizmo commit"'}}]}}])
        self.env.cli('update')
        jsonl(path, [{'type': 'user', 'uuid': 'd-t2', 'sessionId': D, 'timestamp': '2026-09-05T12:00:05.000Z',
                      'cwd': ACME, 'toolUseResult': {'stdout': '[main 1a2b3c4] Late gizmo commit\n', 'stderr': ''},
                      'message': {'role': 'user', 'content': [{'tool_use_id': 'toolu_late', 'type': 'tool_result',
                                                               'content': '[main 1a2b3c4] Late gizmo commit'}]}}])
        self.env.cli('update')
        rows = self.env.sql("SELECT text, extra FROM docs_all WHERE kind='commit' AND session_id=?", (D,))
        self.assertEqual([(t, json.loads(e)['sha']) for t, e in rows], [('Late gizmo commit', '1a2b3c4')])

    def test_shrink_reindexes(self):
        path = self.env.path(D_MAIN)
        with open(path) as fh:
            lines = fh.readlines()
        with open(path, 'w') as fh:
            fh.writelines(lines[:2])
        out = self.env.cli('update', '--subagents')['updated']
        self.assertGreater(out['docs_removed'], 0)
        texts = [r[0] for r in self.env.sql('SELECT text FROM docs_all WHERE session_id=?', (D,))]
        self.assertIn('Is the MIT license fine for the widgets repo?', texts)
        self.assertNotIn('We will use zanzibar for the widget queue.', texts)
        self.assertEqual(self.env.sql('SELECT prompt_count FROM sessions WHERE session_id=?', (D,))[0][0], 1)

    def test_rewritten_head_reindexes(self):
        path = self.env.path(D_MAIN)
        with open(path) as fh:
            lines = fh.readlines()
        first = json.loads(lines[0])
        first['message']['content'] = 'Is the BSD license okay for the widgets repo? Rewritten head.'
        lines[0] = json.dumps(first) + '\n'
        lines.append(json.dumps(rec_user(D, 'd-x', 'One more line so the file grows.', '2026-09-06T10:00:00.000Z',
                                         ACME)) + '\n')
        with open(path, 'w') as fh:
            fh.writelines(lines)
        self.env.cli('update', '--subagents')
        texts = [r[0] for r in self.env.sql('SELECT text FROM docs_all WHERE session_id=?', (D,))]
        self.assertIn('Is the BSD license okay for the widgets repo? Rewritten head.', texts)
        self.assertNotIn('Is the MIT license fine for the widgets repo?', texts)
        self.assertEqual(texts.count('We will use zanzibar for the widget queue.'), 2)  # prompt + decision, once each

    def test_deleted_transcript_keeps_docs_until_pruned(self):
        n = len(self.ids(D))
        os.remove(self.env.path(D_MAIN))
        out = self.env.cli('update', '--subagents')
        self.assertEqual(out['stats']['transcriptsDeleted'], 1)
        self.assertEqual(len(self.ids(D)), n)
        hit = self.env.cli('search', '--query', 'zanzibar', '--project', 'widgets')['hits'][0]
        exp = self.env.cli('expand', '--ref', hit['ref'])
        self.assertFalse(exp['session']['transcriptExists'])
        sess = [s for s in self.env.cli('search', '--query', 'zanzibar')['sessions'] if s['session'] == D]
        self.assertFalse(sess[0]['transcriptExists'])
        self.assertFalse(self.env.cli('recap', '--session', D)['sessions'][0]['transcriptExists'])
        out = self.env.cli('update', '--subagents', '--prune-deleted')
        self.assertEqual(self.ids(D), set())
        self.assertEqual(self.env.sql('SELECT COUNT(*) FROM sessions WHERE session_id=?', (D,))[0][0], 0)
        self.assertEqual(out['stats']['transcriptsDeleted'], 0)

    def test_deleted_memory_file_is_dropped(self):
        os.remove(self.env.path('.claude/projects/-Users-me-project/memory/widget-training.md'))
        self.env.cli('update')
        self.assertEqual(self.env.cli('search', '--query', 'MEMORYMARK')['hits'], [])

    def test_changed_memory_file_is_reindexed(self):
        p = self.env.path('.claude/projects/-Users-me-project/memory/widget-training.md')
        with open(p, 'a') as fh:
            fh.write('\nNew fact: QUOKKAMEMORY.\n')
        st = os.stat(p)
        os.utime(p, (st.st_atime, st.st_mtime + 5))
        self.env.cli('update')
        self.assertEqual(len(self.env.cli('search', '--query', 'QUOKKAMEMORY')['hits']), 1)
        self.assertEqual(len(self.env.cli('search', '--query', 'MEMORYMARK')['hits']), 1)

    def test_forget_session_project_before_and_no_resurrection(self):
        out = self.env.cli('forget', '--session', D)
        self.assertEqual(set(out['forgotten']), {'docs', 'sessions'})
        self.assertGreater(out['forgotten']['docs'], 0)
        self.assertEqual(out['forgotten']['sessions'], 1)
        self.assertEqual(self.ids(D), set())
        self.env.cli('update', '--subagents', '--rebuild')
        self.assertEqual(self.ids(D), set())
        self.assertTrue(all(h['session'] != D for h in self.env.cli('search', '--query', 'zanzibar')['hits']))
        # newer activity in the same transcript comes back
        future = recall.now_ms() + 60_000
        jsonl(self.env.path(D_MAIN), [rec_user(D, 'd-late', 'A newer gizmo prompt after forgetting.', iso(future), ACME)])
        self.env.cli('update')
        texts = [r[0] for r in self.env.sql('SELECT text FROM docs_all WHERE session_id=?', (D,))]
        self.assertEqual(texts, ['A newer gizmo prompt after forgetting.'])
        # a whole project, by name
        out = self.env.cli('forget', '--project', 'project')
        self.assertGreater(out['forgotten']['sessions'], 0)
        self.env.cli('update', '--subagents', '--rebuild')
        self.assertEqual(self.env.sql("SELECT COUNT(*) FROM docs_all WHERE project=?", (PROJ,))[0][0], 0)
        self.assertEqual(self.env.sql('SELECT COUNT(*) FROM sessions WHERE project=?', (PROJ,))[0][0], 0)
        # everything before a date
        self.env.cli('forget', '--before', '2026-09-04')
        self.env.cli('update', '--subagents', '--rebuild')
        self.assertEqual(self.env.sql('SELECT COUNT(*) FROM docs_all WHERE ts>0 AND ts < ?',
                                      (recall.parse_time('2026-09-04'),))[0][0], 0)

    def test_busy_lock(self):
        fd = os.open(self.env.db + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            self.assertEqual(self.env.cli('update'), {'updated': None, 'busy': True})
            # searches never wait for the update lock
            self.assertIn('hits', self.env.cli('search', '--query', 'widget'))
        finally:
            os.close(fd)
        self.assertIsNotNone(self.env.cli('update')['updated'])

    def test_max_seconds_partial_and_resume(self):
        env = Env()
        try:
            out = env.cli('update', '--subagents', '--max-seconds', '0')
            self.assertTrue(out['updated']['partial'])
            out = env.cli('update', '--subagents')
            self.assertFalse(out['updated']['partial'])
            self.assertEqual(out['stats']['docs'], self.first['stats']['docs'])
        finally:
            env.close()

    def test_progress_lines(self):
        env = Env()
        try:
            p = subprocess.run([sys.executable, RECALL, '--db', env.db, '--home', env.home, 'update', '--progress'],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            lines = [json.loads(x) for x in p.stderr.decode().splitlines() if x.startswith('{')]
            self.assertTrue(lines)
            for x in lines:
                self.assertEqual(set(x['progress']), {'files_done', 'files_total', 'bytes_done', 'bytes_total'})
            self.assertEqual(lines[-1]['progress']['files_done'], lines[-1]['progress']['files_total'])
        finally:
            env.close()

    def test_retention_days(self):
        out = self.env.cli('update', '--retention-days', '1')
        self.assertGreater(out['updated']['docs_removed'], 0)
        self.assertEqual(self.env.sql('SELECT COUNT(*) FROM docs_all WHERE ts < ?', (recall.now_ms() - 86400000,))[0][0], 0)


class SecretIndexTest(unittest.TestCase):
    def test_secrets_never_reach_the_index(self):
        env = Env(copy_fixtures=False)
        try:
            gh = 'gh' + 'p_' + 'Q7' * 18
            pw = 'Sw0rd' + 'fish' + 'Fake88'
            aws = 'AKIA' + 'ZZZZ' + 'TESTFAKEKEY2'
            bearer = 'tok' + 'B' * 30
            labelled = 'Corr' + 'ectHorseFake9'
            sid = '88888888-8888-4888-8888-888888888888'
            path = os.path.join(env.home, '.claude/projects/-Users-me-project', sid + '.jsonl')
            cmd = 'curl -H "Authorization: Bearer %s" https://api.example.com && export GITHUB_TOKEN=%s' % (bearer, gh)
            jsonl(path, [
                rec_user(sid, 's1', 'My token is %s and the db password: %s' % (gh, pw), '2026-09-07T10:00:00.000Z'),
                rec_text(sid, 's2', 'Got it. The key %s and wifi password is %s will not be repeated.' % (aws, labelled),
                         '2026-09-07T10:00:10.000Z'),
                {'type': 'assistant', 'uuid': 's3', 'sessionId': sid, 'timestamp': '2026-09-07T10:00:20.000Z', 'cwd': PROJ,
                 'message': {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'toolu_s', 'name': 'Bash',
                                                               'input': {'command': cmd}}]}},
                {'type': 'custom-title', 'customTitle': 'Rotate %s' % gh, 'sessionId': sid},
            ])
            env.cli('update')
            con = sqlite3.connect(env.db)
            con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            con.close()
            blob = b''
            for suffix in ('', '-wal'):
                if os.path.exists(env.db + suffix):
                    with open(env.db + suffix, 'rb') as fh:
                        blob += fh.read()
            for secret in (gh, pw, aws, bearer, labelled):
                for form in (secret, secret.lower()):
                    self.assertNotIn(form.encode(), blob, secret)
            hits = env.cli('search', '--query', 'token password')['hits']
            self.assertTrue(hits)
            self.assertIn('[secret …', ' '.join(h['snippet'] for h in hits) + ' '.join(
                env.cli('expand', '--ref', h['ref'])['items'][0]['text'] for h in hits))
        finally:
            env.close()


class RobustnessTest(unittest.TestCase):
    def setUp(self):
        self.env = Env(copy_fixtures=False)
        self.sid = 'cccccccc-0000-4000-8000-000000000001'
        self.path = os.path.join(self.env.home, '.claude/projects/-Users-me-project', self.sid + '.jsonl')

    def tearDown(self):
        self.env.close()

    def test_huge_base64_lines_and_bad_lines(self):
        image = 'iVBORw0KGgo' + 'A' * 3_000_000
        jsonl(self.path, [
            {'type': 'user', 'uuid': 'r1', 'sessionId': self.sid, 'timestamp': '2026-09-10T10:00:00.000Z', 'cwd': PROJ,
             'message': {'role': 'user', 'content': [
                 {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': image}},
                 {'type': 'text', 'text': 'What is wrong in this screenshot of the gizmo dialog?'}]}},
        ])
        with open(self.path, 'ab') as fh:
            fh.write(b'{"type": "user", "broken json\n')
            fh.write(b'\xff\xfe not utf-8 at all \x80\n')
            fh.write(b'[1, 2, 3]\n')
        jsonl(self.path, [rec_text(self.sid, 'r2', 'The gizmo dialog clips its last button on narrow windows.',
                                   '2026-09-10T10:00:10.000Z')])
        out = self.env.cli('update')
        self.assertNotIn('errors', out['updated'])
        texts = sorted(r[0] for r in self.env.sql('SELECT text FROM docs_all'))
        self.assertEqual(texts, ['The gizmo dialog clips its last button on narrow windows.',
                                 'What is wrong in this screenshot of the gizmo dialog?'])
        self.assertLess(os.path.getsize(self.env.db), 2_000_000)

    def test_search_while_a_write_transaction_is_open(self):
        jsonl(self.path, [rec_user(self.sid, 'w1', 'Index the wombat logs please.', '2026-09-10T11:00:00.000Z')])
        self.env.cli('update')
        con = sqlite3.connect(self.env.db, isolation_level=None)
        try:
            con.execute('BEGIN IMMEDIATE')
            con.execute("INSERT INTO meta(key, value) VALUES ('test-writer', '1')")
            t0 = time.time()
            out = self.env.cli('search', '--query', 'wombat')
            self.assertEqual(len(out['hits']), 1)
            self.assertLess(time.time() - t0, 10)
        finally:
            con.execute('ROLLBACK')
            con.close()

    def test_subagents_without_their_main_transcript(self):
        sub = os.path.join(self.env.home, '.claude/projects/-Users-me-project', self.sid, 'subagents', 'agent-z9.jsonl')
        jsonl(sub, [rec_user(self.sid, 'z1', 'Survey the wombat parsers.', '2026-09-10T12:00:00.000Z'),
                    rec_text(self.sid, 'z2', 'Report: two wombat parsers exist and both lack streaming support.',
                             '2026-09-10T12:00:05.000Z')])
        self.env.cli('update', '--subagents')
        row = self.env.sql('SELECT transcript_exists, transcript_path, prompt_count FROM sessions WHERE session_id=?',
                           (self.sid,))
        self.assertEqual(row, [(0, None, 0)])
        hit = self.env.cli('search', '--query', 'wombat parsers streaming')['hits'][0]
        self.assertTrue(hit['extra']['report'])

    def test_empty_and_partial_files(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        open(self.path, 'w').close()
        with open(self.path.replace(self.sid, 'cccccccc-0000-4000-8000-000000000002'), 'w') as fh:
            fh.write('{"type": "user", "uuid": "p1"')
        out = self.env.cli('update')
        self.assertEqual(out['updated']['docs_added'], 0)
        self.assertEqual(out['stats']['sessions'], 0)

    def test_timegm_matches_calendar(self):
        import calendar
        for y, mo, d, h in ((1970, 1, 1, 0), (2000, 2, 29, 23), (2026, 12, 31, 12), (2100, 3, 1, 5)):
            self.assertEqual(recall._timegm(y, mo, d, h), calendar.timegm((y, mo, d, h, 0, 0, 0, 0, 0)))


def db_bytes(db):
    blob = b''
    for suffix in ('', '-wal'):
        if os.path.exists(db + suffix):
            with open(db + suffix, 'rb') as fh:
                blob += fh.read()
    return blob


def rec_bash(sid, uuid, tid, cmd, ts, cwd=PROJ):
    return {'type': 'assistant', 'uuid': uuid, 'sessionId': sid, 'timestamp': ts, 'cwd': cwd, 'isSidechain': False,
            'message': {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': tid, 'name': 'Bash',
                                                          'input': {'command': cmd}}]}}


class RedactionTest(unittest.TestCase):
    """Literal redaction: redact.txt and secret-named shell exports (all values built at runtime)."""

    def setUp(self):
        self.env = Env(copy_fixtures=False)
        h = self.env.home
        self.wifi = 'Wh' + 'iteRabbit' + '-8841'
        self.token = 'tkn' + '9fake' + 'Q2w3E4r5'
        self.pw = 'Sw0rd' + 'fishFake' + '77'
        self.later = 'Pl' + 'umTree' + '-5521'
        self.short = 'ab' + 'c12'
        self.path_val = '/Users/me/.ssh/' + 'id_widget'
        self.url_val = 'https://auth.example.com/' + 'login'
        self.editor = 'widget' + 'vim42'
        self.short_export = 'sh' + 'ort12'
        with open(os.path.join(h, '.zshrc'), 'w') as fh:
            fh.write('# shell setup\nexport EDITOR=%s\nexport GH_TOKEN="%s"\nexport DB_PASSWORD=\'%s\'  # db\n'
                     'export API_TOKEN=$OTHER_TOKEN\nexport SSH_KEY_PATH=%s\nexport AUTH_URL=%s\n'
                     'export MY_PASS=%s\nalias ll="ls -la"\n' % (self.editor, self.token, self.pw, self.path_val,
                                                                 self.url_val, self.short_export))
        self.redact = os.path.join(h, '.claude', 'recall', 'redact.txt')
        os.makedirs(os.path.dirname(self.redact))
        with open(self.redact, 'w') as fh:
            fh.write('# the guest network\n%s\n\n%s\n' % (self.wifi, self.short))
        sid = 'dddddddd-0000-4000-8000-000000000001'
        self.path = os.path.join(h, '.claude/projects/-Users-me-project', sid + '.jsonl')
        cmd = 'echo %s | pbcopy && curl -H "X-Api: %s" https://api.example.com/v1' % (self.wifi, self.token)
        jsonl(self.path, [
            rec_user(sid, 'k1', 'Join with %s; the db uses %s. Unrelated: %s %s %s %s %s %s.' % (
                self.wifi, self.pw, self.later, self.short, self.path_val, self.url_val, self.editor,
                self.short_export), '2026-09-11T10:00:00.000Z'),
            rec_bash(sid, 'k2', 'toolu_k2', cmd, '2026-09-11T10:00:05.000Z'),
        ])
        self.secrets = (self.wifi, self.token, self.pw)

    def tearDown(self):
        self.env.close()

    def run_raw(self, *args):
        p = subprocess.run([sys.executable, RECALL, '--db', self.env.db, '--home', self.env.home] + list(args),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        return p.stdout.decode() + p.stderr.decode()

    def test_literals_masked_at_index_time(self):
        out = self.env.cli('update')
        self.assertNotIn('remasked', out['updated'])  # a fresh index has nothing to re-mask
        self.assertEqual(out['stats']['redactLiterals'], 3)
        texts = '\n'.join(r[0] for r in self.env.sql('SELECT text FROM docs_all'))
        for secret in self.secrets:
            self.assertNotIn(secret, texts)
        for kept in (self.later, self.short, self.path_val, self.url_val, self.editor, self.short_export):
            self.assertIn(kept, texts)
        self.assertIn('[secret …8841]', texts)
        cmd = self.env.sql("SELECT text FROM docs_all WHERE kind='command'")[0][0]
        self.assertIn('[secret …8841] | pbcopy', cmd)
        self.assertIn('[secret …E4r5]', cmd)
        blob = db_bytes(self.env.db)
        for secret in self.secrets:
            self.assertNotIn(secret.encode(), blob)
            self.assertNotIn(secret.lower().encode(), blob)

    def test_literal_values_are_never_printed(self):
        printed = self.run_raw('update') + self.run_raw('stats') + self.run_raw('remask') + \
            self.run_raw('update', '--progress') + self.run_raw('search', '--query', 'db')
        for secret in self.secrets:
            self.assertNotIn(secret, printed)

    def test_adding_a_literal_later_remasks_and_unchanged_set_does_nothing(self):
        self.env.cli('update')
        self.assertEqual(len(self.env.cli('search', '--query', self.later)['hits']), 1)
        again = self.env.cli('update')
        self.assertNotIn('remasked', again['updated'])  # same literal set: no work
        with open(self.redact, 'a') as fh:
            fh.write(self.later + '\n')
        out = self.env.cli('update')
        self.assertEqual(out['updated']['remasked'], 1)
        self.assertEqual(out['stats']['redactLiterals'], 4)
        self.assertEqual(self.env.cli('search', '--query', self.later)['hits'], [])
        self.assertEqual(self.env.cli('search', '--query', '"%s"' % self.later)['hits'], [])
        self.assertEqual(self.env.cli('search', '--query', 'plumtree')['hits'], [])
        blob = db_bytes(self.env.db)
        for form in (self.later, self.later.lower(), 'plumtree'):
            self.assertNotIn(form.encode(), blob)
        self.assertNotIn('remasked', self.env.cli('update')['updated'])
        r = self.env.cli('remask')
        self.assertEqual(set(r['remasked']), {'docs', 'seconds'})
        self.assertEqual(r['remasked']['docs'], 0)

    def test_remask_command_after_editing_redact_txt(self):
        self.env.cli('update')
        with open(self.redact, 'a') as fh:
            fh.write(self.later + '\n')
        r = self.env.cli('remask')
        self.assertEqual(r['remasked']['docs'], 1)
        self.assertNotIn('remasked', self.env.cli('update')['updated'])  # remask recorded the new set
        self.assertEqual(self.env.cli('search', '--query', self.later)['hits'], [])

    def test_loading_rules(self):
        lits = recall.load_literals(self.env.home)
        self.assertEqual(sorted(lits), sorted(self.secrets))
        self.assertEqual([len(x) for x in lits], sorted((len(x) for x in lits), reverse=True))
        v = recall.shell_export_value
        self.assertEqual(v('"a\\"b$"'), None)
        self.assertEqual(v("'lit$eral'  # c"), 'lit$eral')
        self.assertEqual(v('plain123;more'), 'plain123')
        self.assertEqual(v('$HOME/x'), None)
        self.assertTrue(recall._export_worthy('https://user:' + 'pa55word' + '@db.example.com'))
        self.assertTrue(recall._export_worthy('https://api.example.com/v1?api_key=' + 'abcdef12'))
        self.assertFalse(recall._export_worthy('https://api.example.com/v1'))
        try:
            recall.set_redaction(['longer-' + 'literal', 'longer'])
            self.assertEqual(recall.mask_secrets('x longer-literal y longer z'),
                             'x [secret …eral] y [secret …nger] z')
        finally:
            recall.set_redaction([])


class CompoundQueryTest(unittest.TestCase):
    def test_hyphenated_terms_match_flags_pieces_and_phrases(self):
        env = Env(copy_fixtures=False)
        try:
            sid = 'eeeeeeee-0000-4000-8000-000000000001'
            jsonl(os.path.join(env.home, '.claude/projects/-Users-me-project', sid + '.jsonl'), [
                rec_bash(sid, 'c1', 'toolu_c1', 'gh repo edit --delete-branch-on-merge', '2026-09-12T10:00:00.000Z'),
                rec_user(sid, 'c2', 'Should GitHub delete branch on merge for this repo?', '2026-09-12T10:01:00.000Z'),
                rec_user(sid, 'c3', 'Pass --flag-name to the widget tool.', '2026-09-12T10:02:00.000Z'),
            ])
            env.cli('update')
            for q in ('delete-branch-on-merge', '--delete-branch-on-merge', '"delete branch on merge"'):
                kinds = sorted(h['kind'] for h in env.cli('search', '--query=' + q)['hits'])
                self.assertEqual(kinds, ['command', 'prompt'], q)
            flag = env.cli('search', '--query', 'flag-name')['hits']
            self.assertEqual(len(flag), 1)
            self.assertIn('[[', flag[0]['snippet'])
            self.assertEqual(len(env.cli('search', '--query=--flag-name')['hits']), 1)  # a flag, not a negation
        finally:
            env.close()


class SessionProjectTest(unittest.TestCase):
    def test_one_project_per_session_with_record_cwd_in_extra(self):
        env = Env(copy_fixtures=False)
        try:
            sid = 'ffffffff-0000-4000-8000-000000000001'
            wt = PROJ + '/.claude/worktrees/agent-x'
            jsonl(os.path.join(env.home, '.claude/projects/-Users-me-project', sid + '.jsonl'), [
                rec_user(sid, 'p1', 'Start the quokka migration in this repo.', '2026-09-13T10:00:00.000Z', PROJ),
                rec_text(sid, 'p2', 'Moved into the widgets checkout to compare the quokka loader there.',
                         '2026-09-13T10:01:00.000Z', ACME),
                rec_bash(sid, 'p3', 'toolu_p3', 'make quokka', '2026-09-13T10:02:00.000Z', ACME),
            ])
            jsonl(os.path.join(env.home, '.claude/projects/-Users-me-project', sid, 'subagents', 'agent-q1.jsonl'), [
                rec_user(sid, 'q1', 'Survey the quokka call sites.', '2026-09-13T10:03:00.000Z', wt),
                rec_text(sid, 'q2', 'Report: the quokka loader is called from two places in the widget scorer.',
                         '2026-09-13T10:04:00.000Z', wt),
            ])
            env.cli('update', '--subagents')
            rows = env.sql('SELECT project, extra FROM docs_all WHERE session_id=?', (sid,))
            self.assertTrue(rows)
            self.assertEqual({r[0] for r in rows}, {PROJ})
            cwds = sorted({json.loads(r[1] or '{}').get('cwd') or '-' for r in rows})
            self.assertEqual(cwds, ['-', ACME, wt])
            self.assertEqual(env.sql('SELECT project, cwd FROM sessions'), [(PROJ, PROJ)])
            self.assertTrue(env.cli('search', '--query', 'quokka', '--project', 'project')['hits'])
            self.assertEqual(env.cli('search', '--query', 'quokka', '--project', 'widgets')['hits'], [])
            boosted = env.cli('search', '--query', 'quokka loader', '--boost-project', 'project')['hits']
            plain = {h['ref']: h['score'] for h in env.cli('search', '--query', 'quokka loader')['hits']}
            for h in boosted:
                self.assertAlmostEqual(h['score'] / plain[h['ref']], 1.5, delta=0.01)
        finally:
            env.close()


class InspectCommandTest(unittest.TestCase):
    INSPECT = ["sed -n '1,40p' src/app.py", 'rg -n "modal" src/ | head', 'ls -la && git status && git log -5',
               'sleep 30 && tail -5 /tmp/train.log', 'gh pr view 12 --json state', 'gh run list --limit 5',
               'python3 -c "import modal; print(modal.__version__)"', 'git -C /x diff HEAD~1',
               "python3 - <<'EOF'\nimport json\nprint(json.load(open('a.json')))\nEOF", 'find . -name "*.py" | wc -l',
               'ps aux | grep modal | grep -v grep', 'cd /x && git branch -a', 'cat <<EOF\nhello\nEOF']
    ACTION = ['cd x && modal run train.py', 'modal deploy app.py', 'git commit -m "x"', 'echo hi > out.txt',
              "sed -i 's/a/b/' f", 'find . -name "*.pyc" -delete', 'gh pr merge 12', 'git branch -D old',
              'python3 -c "open(\'x\', \'w\').write(\'y\')"', 'gh api -X POST repos/a/b/issues -f title=x',
              "cat > run.sh <<'EOF'\necho hi\nEOF", 'ls | xargs rm', 'pytest -q', 'git push', '']

    def test_classifier(self):
        for c in self.INSPECT:
            self.assertTrue(recall.is_inspection(c), c)
        for c in self.ACTION:
            self.assertFalse(recall.is_inspection(c), c)

    def test_list_hides_inspection_and_search_ranks_it_low(self):
        env = Env(copy_fixtures=False)
        try:
            sid = 'abababab-0000-4000-8000-000000000001'
            jsonl(os.path.join(env.home, '.claude/projects/-Users-me-project', sid + '.jsonl'), [
                rec_bash(sid, 'm1', 'toolu_m1', 'rg -n "modal deploy" src/ docs/', '2026-09-14T10:00:00.000Z'),
                rec_bash(sid, 'm2', 'toolu_m2', 'grep -rn "modal deploy" README.md', '2026-09-14T10:01:00.000Z'),
                rec_bash(sid, 'm3', 'toolu_m3', 'cd service && modal deploy app.py', '2026-09-14T10:02:00.000Z'),
            ])
            out = env.cli('update')
            self.assertEqual(out['stats']['inspectCommands'], 2)
            listed = env.cli('list', '--kind', 'command', '--query', 'modal deploy')['items']
            self.assertEqual([i['text'] for i in listed], ['cd service && modal deploy app.py'])
            everything = env.cli('list', '--kind', 'command', '--query', 'modal deploy', '--include-inspect')['items']
            self.assertEqual(len(everything), 3)
            self.assertEqual(sum(1 for i in everything if i['extra'].get('inspect')), 2)
            hits = env.cli('search', '--query', 'modal deploy')['hits']
            self.assertEqual(hits[0]['text'] if 'text' in hits[0] else hits[0]['snippet'].replace('[[', '').replace(
                ']]', ''), 'cd service && modal deploy app.py')
            self.assertEqual(len(hits), 3)
        finally:
            env.close()


class MigrationTest(unittest.TestCase):
    def test_v1_index_upgrades_in_place_and_keeps_deleted_transcripts(self):
        env = Env()
        try:
            env.cli('update', '--subagents')
            before = env.sql('SELECT COUNT(*) FROM docs')[0][0]
            # make it look like a schema-1 index, and lose one transcript (its docs must survive)
            con = sqlite3.connect(env.db)
            con.execute('ALTER TABLE docs DROP COLUMN flags')
            con.execute('ALTER TABLE files DROP COLUMN fmt')
            con.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
            con.execute("DELETE FROM meta WHERE key='index_format'")
            con.commit()
            con.close()
            sub = env.path('.claude/projects/-Users-me-project/%s/subagents/agent-a0000000000000001.jsonl' % A)
            os.remove(sub)
            out = env.cli('update', '--subagents')
            self.assertEqual(env.sql("SELECT value FROM meta WHERE key='schema_version'"), [('2',)])
            self.assertEqual(env.sql("SELECT value FROM meta WHERE key='index_format'"), [(str(recall.INDEX_FORMAT),)])
            self.assertEqual(env.sql('SELECT COUNT(*) FROM files WHERE fmt < ?', (recall.INDEX_FORMAT,))[0][0], 0)
            self.assertEqual(out['stats']['docs'], before)
            rg = env.sql("SELECT flags, extra FROM docs_all WHERE text LIKE 'rg -n \"def train\"%'")
            self.assertEqual(len(rg), 1)
            self.assertEqual(rg[0][0] & recall.FLAG_INSPECT, recall.FLAG_INSPECT)  # fixed in place
            self.assertTrue(json.loads(rg[0][1])['inspect'])
            self.assertTrue(env.cli('search', '--query', 'SUBAGENTREPORTMARK')['hits'])
            second = env.cli('update', '--subagents')['updated']
            self.assertEqual((second['files'], second['docs_added']), (0, 0))
        finally:
            env.close()


class RecencyTest(unittest.TestCase):
    def test_recent_beats_old_for_the_same_text(self):
        env = Env(copy_fixtures=False)
        try:
            now = recall.now_ms()
            for sid, age in (('99999999-0000-4000-8000-000000000001', 200), ('99999999-0000-4000-8000-000000000002', 1)):
                ts = now - age * 86400000
                jsonl(os.path.join(env.home, '.claude/projects/-Users-me-project', sid + '.jsonl'),
                      [rec_user(sid, sid[-4:] + 'u', 'How did the quokka migration go?', iso(ts)),
                       rec_text(sid, sid[-4:] + 'a', 'The quokka migration finished without errors on all widget shards.',
                                iso(ts + 1000))])
            env.cli('update')
            hits = env.cli('search', '--query', 'quokka migration finished')['hits']
            self.assertEqual(hits[0]['session'], '99999999-0000-4000-8000-000000000002')
            flat = env.cli('search', '--query', 'quokka migration finished', '--half-life-days', '100000')['hits']
            self.assertAlmostEqual(flat[0]['score'], flat[1]['score'], delta=flat[0]['score'] * 0.01)
        finally:
            env.close()


class GitWorktreeTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('git'), 'git is not installed')
    def test_separate_worktree_folder_groups_with_main_repo(self):
        env = Env(copy_fixtures=False)
        try:
            repo = os.path.realpath(os.path.join(env.tmp, 'gizmo'))
            wt = os.path.realpath(os.path.join(env.tmp, 'gizmo-wt'))
            os.makedirs(repo)
            git = ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main']
            subprocess.run(git + ['init', '-q', repo], check=True)
            with open(os.path.join(repo, 'README'), 'w') as fh:
                fh.write('gizmo\n')
            subprocess.run(git + ['-C', repo, 'add', 'README'], check=True)
            subprocess.run(git + ['-C', repo, 'commit', '-q', '-m', 'init'], check=True)
            subprocess.run(git + ['-C', repo, 'worktree', 'add', '-q', '-b', 'feature', wt], check=True)
            os.makedirs(os.path.join(wt, 'src'))
            for sid, cwd in (('aaaaaaaa-0000-4000-8000-000000000001', repo),
                             ('aaaaaaaa-0000-4000-8000-000000000002', os.path.join(wt, 'src'))):
                jsonl(os.path.join(env.home, '.claude/projects/-x', sid + '.jsonl'),
                      [rec_user(sid, sid[-4:], 'Work on the gizmo repository please.', '2026-09-08T10:00:00.000Z', cwd)])
            env.cli('update')
            keys = {r[0] for r in env.sql('SELECT project FROM sessions')}
            self.assertEqual(keys, {repo})
            projects = env.cli('projects')['projects']
            self.assertEqual(projects[0]['name'], 'gizmo')
            self.assertEqual(env.cli('recap', '--project', wt)['sessions'][0]['projectName'], 'gizmo')
        finally:
            env.close()


if __name__ == '__main__':
    unittest.main()
