import { expect, test } from 'claude-code/testing'

import {
  characterClasses,
  describeFindings,
  detect,
  fencedRanges,
  hashText,
  isCodeLike,
  isPath,
  isPlaceholder,
  isReference,
  isSecretValue,
  labelName,
  mask,
  serviceOf,
  testReport,
  toEnvName,
  typedName,
} from '../hooks/detect'

// Every secret here is built at run time from obviously fake parts, so no secret scanner mistakes this
// file for a leak and no real credential ever sits in the repository.
const FAKE = {
  awsKeyId: 'AKIA' + 'FAKE'.repeat(4),
  awsSessionKeyId: 'ASIA' + 'TEST2345' + 'FAKE6789',
  awsSecret: 'Fk' + 'q9Zr/'.repeat(6) + 'Ab12' + 'vxrm',
  github: (prefix: string) => `${prefix}_` + 'FakeToken0'.repeat(4).slice(0, 36),
  githubPat: 'github_' + 'pat_' + 'Fake0Test1'.repeat(3) + '_' + 'Fake2Test3'.repeat(6),
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'Fake0Test1'.repeat(4),
  openai: 'sk-' + 'Fake0Test1'.repeat(4),
  openaiProject: 'sk-' + 'proj-' + 'Fake0Test1'.repeat(4),
  slack: 'xox' + 'b-' + '1234567890-' + 'Fake0Test1Fake',
  google: 'AI' + 'za' + 'Fake0Test1'.repeat(3) + 'Fake0',
  huggingface: 'hf_' + 'Fake0Test1'.repeat(3) + 'Ab',
  gitlab: 'glpat-' + 'Fake0Test1'.repeat(2),
  npm: 'npm_' + 'Fake0Test1'.repeat(4).slice(0, 36),
  stripe: 'sk_' + 'live_' + 'Fake0Test1'.repeat(3),
  stripeRestricted: 'rk_' + 'live_' + 'Fake0Test1'.repeat(3),
  privateKey:
    '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----\n' + 'MIIEow' + 'Fake0Test1'.repeat(6) + '\n-----END ' + 'RSA PRIVATE' + ' KEY-----',
  bearer: 'eyJ' + 'Fake0Test1'.repeat(3),
}

/** The dataset service's pair as it was pasted: two labels, each value alone on the next line. */
const KEY_ID = 'fake0id1' + 'test2id3' + 'zp3n'
const SECRET_KEY = 'FakeSecret0'.repeat(3) + 'vxrm'
const PASTE = `Here are my keys for opendatalab:\nAccess Key ID\n${KEY_ID}\nSecret Access Key\n${SECRET_KEY}\nCan you download the dataset?`

const SHA = '3f786850' + 'e387550f' + 'dab836ed' + '7e6dc881' + 'de23001b'

const SHAPES: [string, string, string, string][] = [
  ['AWS access key ID', FAKE.awsKeyId, 'aws-access-key-id', 'AWS_ACCESS_KEY_ID'],
  ['AWS session key ID', FAKE.awsSessionKeyId, 'aws-access-key-id', 'AWS_ACCESS_KEY_ID'],
  ...['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map(
    (prefix): [string, string, string, string] => [`GitHub ${prefix}_ token`, FAKE.github(prefix), 'github-token', 'GITHUB_TOKEN'],
  ),
  ['GitHub fine-grained token', FAKE.githubPat, 'github-token', 'GITHUB_TOKEN'],
  ['Anthropic key', FAKE.anthropic, 'anthropic-key', 'ANTHROPIC_API_KEY'],
  ['OpenAI key', FAKE.openai, 'openai-key', 'OPENAI_API_KEY'],
  ['OpenAI project key', FAKE.openaiProject, 'openai-key', 'OPENAI_API_KEY'],
  ['Slack token', FAKE.slack, 'slack-token', 'SLACK_TOKEN'],
  ['Google API key', FAKE.google, 'google-api-key', 'GOOGLE_API_KEY'],
  ['Hugging Face token', FAKE.huggingface, 'huggingface-token', 'HF_TOKEN'],
  ['GitLab token', FAKE.gitlab, 'gitlab-token', 'GITLAB_TOKEN'],
  ['npm token', FAKE.npm, 'npm-token', 'NPM_TOKEN'],
  ['Stripe live key', FAKE.stripe, 'stripe-key', 'STRIPE_SECRET_KEY'],
  ['Stripe restricted key', FAKE.stripeRestricted, 'stripe-key', 'STRIPE_SECRET_KEY'],
  ['private key block', FAKE.privateKey, 'private-key', 'PRIVATE_KEY'],
]

for (const [what, value, kind, name] of SHAPES) {
  test(`finds a ${what} in prose, exactly`, () => {
    const text = `can you check why this fails: ${value}\nthanks`
    const found = detect(text)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind, name, value })
    expect(text.slice(found[0]?.start, found[0]?.end)).toBe(value)
  })
}

test('an AWS key ID brings the 40-character secret beside it; a lone 40-character string is nothing', () => {
  const found = detect(`aws configure: ${FAKE.awsKeyId} / ${FAKE.awsSecret}`)
  expect(found.map(one => [one.kind, one.name, one.value])).toEqual([
    ['aws-access-key-id', 'AWS_ACCESS_KEY_ID', FAKE.awsKeyId],
    ['aws-secret-access-key', 'AWS_SECRET_ACCESS_KEY', FAKE.awsSecret],
  ])
  expect(detect(`checksum ${FAKE.awsSecret} ok`)).toEqual([])
})

test('a Bearer token in a pasted curl command', () => {
  const found = detect(`curl -H "Authorization: Bearer ${FAKE.bearer}" https://example.com/v1/items`)
  expect(found.map(one => [one.kind, one.value])).toEqual([['bearer-token', FAKE.bearer]])
})

test('a password inside a URL, named for its scheme; the rest of the URL stays', () => {
  const text = 'connect to postgres://app:' + 'Fake0Pass9' + '@db.internal:5432/app'
  const found = detect(text)
  expect(found.map(one => [one.kind, one.name, one.value])).toEqual([['url-password', 'POSTGRES_PASSWORD', 'Fake0Pass9']])
})

test('the two-line Access Key ID / Secret Access Key paste is two secrets named for the service', () => {
  const found = detect(PASTE)
  expect(found.map(one => [one.label, one.name, one.value])).toEqual([
    ['Access Key ID', 'OPENDATALAB_ACCESS_KEY_ID', KEY_ID],
    ['Secret Access Key', 'OPENDATALAB_SECRET_ACCESS_KEY', SECRET_KEY],
  ])
  expect(mask(found[1]?.value ?? '')).toBe('…vxrm')
})

test('the Wi-Fi password sentence', () => {
  const found = detect('The wifi password for the guest network is Corr3ct-Horse-42, can you put it in the setup script?')
  expect(found.map(one => [one.label, one.name, one.value])).toEqual([['wifi password', 'GUEST_WIFI_PASSWORD', 'Corr3ct-Horse-42']])
  expect(detect('Wi-Fi password: Tr0ub4dor&3')[0]?.name).toBe('WIFI_PASSWORD')
  expect(detect('my password is hunter22')[0]?.value).toBe('hunter22')
})

test('labels tie to values by colon, equals, JSON keys, markdown bold and env-file identifiers', () => {
  const env = `DB_PASSWORD=Abc12345xyz\nexport KIT_API_KEY='kt_${'Z9y8X7w6'.repeat(3)}'\nclient_secret: "Fake0Client1Secret"`
  expect(detect(env).map(one => [one.name, one.value])).toEqual([
    ['DB_PASSWORD', 'Abc12345xyz'],
    ['KIT_API_KEY', `kt_${'Z9y8X7w6'.repeat(3)}`],
    ['CLIENT_SECRET', 'Fake0Client1Secret'],
  ])
  expect(detect('{"access_token": "Fake0Access1Token", "token_type": "bearer"}').map(one => one.name)).toEqual(['ACCESS_TOKEN'])
  expect(detect('**Password:** Tr0ub4dor&3').map(one => one.value)).toEqual(['Tr0ub4dor&3'])
})

test('ignores env var references', () => {
  expect(detect('Use $KIT_API_KEY (or ${KIT_API_KEY}); token: $GITHUB_TOKEN; password: ${DB_PASSWORD}')).toEqual([])
  expect(detect('in ~/.zshrc there is KIT_API_KEY')).toEqual([])
  expect(detect('api_key: process.env.KIT_API_KEY\npassword: "{{ secrets.DB_PASSWORD }}"\nsecret = os.getenv("X")')).toEqual([])
})

test('ignores placeholders', () => {
  const text = [
    'api_key: xxxxxxxxxxxx',
    'password: ********',
    'token: <your-token>',
    'secret: your-key-here',
    'password: changeme123',
    `GitHub: ${'ghp_' + 'x'.repeat(36)}`,
  ].join('\n')
  expect(detect(text)).toEqual([])
})

test('ignores git SHAs unless a label says they are a secret', () => {
  expect(detect(`Merged ${SHA} into main; revert ${SHA.slice(0, 7)} if it breaks`)).toEqual([])
  expect(detect(`token: ${SHA}`).map(one => one.value)).toEqual([SHA])
})

test('ignores URLs without credentials and file paths', () => {
  expect(detect('Docs at https://example.com/api/token?x=1 and token: https://example.com/oauth/token')).toEqual([])
  expect(detect('token: ~/.config/gh/hosts.yml\npassword: /etc/app/password.txt\nsecret: config/secrets.yml')).toEqual([])
})

test('ignores ordinary prose and code that mention passwords and tokens', () => {
  const prose =
    'Can you add a password reset flow? The password must be at least 8 characters and the token expires after 1 hour. ' +
    'The password is required and the API key is optional. Passwords must be rotated. Token-based auth: enabled.'
  expect(detect(prose)).toEqual([])
  expect(detect('const token = getToken(user); password = config.password; self.api_key = api_key')).toEqual([])
  expect(detect('PASSWORD_MIN_LENGTH = 12345678\nmax_tokens: 12345678\ntoken: 87654321')).toEqual([])
})

test('fenced code that says EXAMPLE is an example; the same line outside a fence is not', () => {
  const key = 'AKIA' + 'FAKE0000' + 'EXAMPLE' + 'Q'
  expect(detect('```ini\naws_access_key_id = ' + key + '\n```')).toEqual([])
  expect(detect('aws_access_key_id = ' + key).map(one => one.value)).toEqual([key])
  expect(fencedRanges('a\n```\nb\n```\nc')).toEqual([[2, 11]])
})

test('masking shows at most the last 4 characters and never more than a fifth', () => {
  expect(mask(FAKE.awsSecret)).toBe('…vxrm')
  expect(mask('hunter22')).toBe('…2')
  expect(mask('Abc12345xyz')).toBe('…yz')
  expect(mask('abc')).toBe('…')
  expect(mask(FAKE.privateKey)).toBe('(key block)')
})

test('suggests a name from the label and the words nearby', () => {
  expect(detect('my KIT api key: kt_' + 'a1B2c3D4e5'.repeat(2))[0]?.name).toBe('KIT_API_KEY')
  expect(detect(`OPENAI_API_KEY=${FAKE.openaiProject}`)[0]?.name).toBe('OPENAI_API_KEY')
  expect(detect(`token: ${FAKE.github('ghp')}`)[0]?.name).toBe('GITHUB_TOKEN')
  expect(detect('the api key for staging is Ab12Cd34Ef56')[0]?.name).toBe('STAGING_API_KEY')
  expect(detect('Here is the Access Key ID for the cluster:\nABCD1234EFGH5678\nthanks')[0]?.name).toBe('CLUSTER_ACCESS_KEY_ID')
  expect(detect('password: Abc12345xyz, password: Qwe45678rty').map(one => one.name)).toEqual(['PASSWORD', 'PASSWORD_2'])
})

test('the person\'s own pattern: a match with no service nearby is SECRET_1, SECRET_2', () => {
  const extra = /kit_[a-z0-9]{32}/
  const one = 'kit_' + 'a1b2c3d4'.repeat(4)
  const two = 'kit_' + 'e5f6a7b8'.repeat(4)
  expect(detect(`use ${one} and ${two}`, { extra }).map(f => [f.kind, f.name, f.value])).toEqual([
    ['custom', 'SECRET_1', one],
    ['custom', 'SECRET_2', two],
  ])
  expect(detect(`use ${one}`)).toEqual([])
})

test('names are [A-Z][A-Z0-9_]*', () => {
  expect(toEnvName('opendatalab.com access')).toBe('OPENDATALAB_COM_ACCESS')
  expect(toEnvName('9lives')).toBe('SECRET_9LIVES')
  expect(toEnvName('--')).toBe('')
  expect(typedName('kit-api key')).toBe('KIT_API_KEY')
  expect(typedName('kit_')).toBe('KIT_')
  expect(serviceOf('api.openai.com')).toBe('openai')
  expect(serviceOf('opendatalab.com')).toBe('opendatalab')
  expect(labelName('Secret Access Key')).toBe('SECRET_ACCESS_KEY')
  expect(labelName('apikey')).toBe('API_KEY')
  expect(labelName('passwd')).toBe('PASSWORD')
  expect(labelName('Wi-Fi password')).toBe('WIFI_PASSWORD')
})

test('the value checks', () => {
  expect(isSecretValue('hunter22')).toBe(true)
  expect(isSecretValue('required')).toBe(false)
  expect(isSecretValue('12345678')).toBe(false)
  expect(isSecretValue('12345678', 'wifi password')).toBe(true)
  expect(isReference('${HOME}')).toBe(true)
  expect(isReference('%APPDATA%')).toBe(true)
  expect(isPlaceholder('<token>')).toBe(true)
  expect(isPlaceholder('Corr3ct-Horse-42')).toBe(false)
  expect(isPath('~/.ssh/id_rsa')).toBe(true)
  expect(isPath(FAKE.awsSecret)).toBe(false)
  expect(isCodeLike('accessToken')).toBe(true)
  expect(isCodeLike('Abc12345xyz')).toBe(false)
  expect(characterClasses('aB3-')).toBe(4)
})

test('a fingerprint ignores invisible characters and the ends, and nothing else', () => {
  expect(hashText(PASTE)).toBe(hashText(`​${PASTE}\n`))
  expect(hashText(PASTE)).not.toBe(hashText(PASTE.replace('vxrm', 'vxrn')))
  expect(hashText(PASTE)).not.toContain(SECRET_KEY)
})

test('/secrets test reports masked findings and never a value', () => {
  const report = testReport(detect(PASTE))
  expect(report).toBe(
    [
      'secret-guard would hold that prompt back: 2 secrets.',
      `  Access Key ID ${mask(KEY_ID)} → $OPENDATALAB_ACCESS_KEY_ID`,
      '  Secret Access Key …vxrm → $OPENDATALAB_SECRET_ACCESS_KEY',
    ].join('\n'),
  )
  expect(report).not.toContain(KEY_ID)
  expect(report).not.toContain(SECRET_KEY)
  expect(testReport([])).toBe('secret-guard finds no secret in that text: it would be sent as is.')
  expect(describeFindings(['Secret Access Key'])).toBe('a secret (Secret Access Key)')
  expect(describeFindings(['a', 'b', 'c'])).toBe('3 secrets')
})
