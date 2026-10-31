#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  AUDIENCES,
  BACKGROUND_QUESTIONS,
  FeedbackService,
  FirestoreAssessmentRepository,
  FirestoreIdentityRepository,
  LEVELS,
  MAX_POOL_CAP,
  PLAN_NAMES,
  REPORT_REASONS,
  SCOPES,
  TONES,
  VertexEmbedder,
  cleanContext,
  cosine,
  createFirestore,
  createGenAiClient,
  createLogger,
  generateApiKey,
  loadConfig,
  noiseFloor,
  normalizeTopic,
  requestText,
  type Audience,
  type Level,
  type PlanName,
  type PoolCapRule,
  type Scope,
  type Tone,
} from '@synapset/core';

const USAGE = `Usage: pnpm admin <command> [options]

  account create  --name <name> [--plan free|pro|enterprise]
  account plan    --account <id> --plan <plan>
  account suspend --account <id>
  account resume  --account <id>
  key create      --account <id> --name <name> [--scopes a,b] [--expires-days <n>]
  key list        --account <id>
  key revoke      --key <keyId>

  feedback list       [--limit <n>]        latest question reports
  feedback summary    [--limit <n>]        reports by reason, reused vs generated
  question quarantine --question <id>      stop reusing a question and expire assessments using it
  question restore    --question <id>      reactivate after review and dismiss its reports
  calibrate           [--file <path>]      measure reuse margins on a labelled set (default calibration.json)

  pool-cap list                            live caps (QUESTION_POOL_CAP applies where no rule matches)
  pool-cap set    --cap <n> [dimensions]   raise or lower a cap, live within 30 seconds, no deploy
  pool-cap remove [dimensions]             drop the rule with exactly these dimensions

Dimensions, all optional; the most specific matching rule wins:
  --topic <text> --audience ${AUDIENCES.join('|')} --tone ${TONES.join('|')} --locale <tag> --level ${LEVELS.join('|')}

Scopes: ${SCOPES.join(', ')} (default: all)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    plan: { type: 'string' },
    account: { type: 'string' },
    key: { type: 'string' },
    scopes: { type: 'string' },
    'expires-days': { type: 'string' },
    question: { type: 'string' },
    limit: { type: 'string' },
    file: { type: 'string' },
    cap: { type: 'string' },
    topic: { type: 'string' },
    audience: { type: 'string' },
    tone: { type: 'string' },
    locale: { type: 'string' },
    level: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== 'string' || !value) fail(`Missing --${name}`);
  return value;
}

function plan(): PlanName {
  const value = values.plan ?? 'free';
  if (!(PLAN_NAMES as readonly string[]).includes(value)) fail(`Unknown plan "${value}"`);
  return value as PlanName;
}

function scopes(): Scope[] {
  if (!values.scopes) return [...SCOPES];
  const list = values.scopes.split(',').map((s) => s.trim());
  const unknown = list.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length) fail(`Unknown scopes: ${unknown.join(', ')}`);
  return list as Scope[];
}

function limit(fallback: number): number {
  const value = values.limit ? Number(values.limit) : fallback;
  if (!(Number.isInteger(value) && value > 0 && value <= 5000))
    fail('--limit must be an integer from 1 to 5000');
  return value;
}

function capDimensions(): Omit<PoolCapRule, 'cap'> {
  const { topic, audience, tone, locale, level } = values;
  if (audience && !(AUDIENCES as readonly string[]).includes(audience))
    fail(`Unknown audience "${audience}"`);
  if (tone && !(TONES as readonly string[]).includes(tone)) fail(`Unknown tone "${tone}"`);
  if (level && !LEVELS.map(String).includes(level)) fail(`Unknown level "${level}"`);
  return {
    ...(topic ? { topic: normalizeTopic(topic) } : {}),
    ...(audience ? { audience: audience as Audience } : {}),
    ...(tone ? { tone: tone as Tone } : {}),
    ...(locale ? { locale } : {}),
    ...(level ? { level: Number(level) as Level } : {}),
  };
}

const sameDimensions = (a: Omit<PoolCapRule, 'cap'>, b: PoolCapRule) => {
  const { cap: _cap, ...others } = b;
  const keys = (rule: Record<string, unknown>) =>
    JSON.stringify(Object.entries(rule).sort(([x], [y]) => x.localeCompare(y)));
  return keys(a) === keys(others);
};

const config = loadConfig();
const firestore = createFirestore(config);
const identities = new FirestoreIdentityRepository(firestore);
const assessments = new FirestoreAssessmentRepository(firestore);
const feedback = new FeedbackService(
  assessments,
  { quarantineAfterReports: config.FEEDBACK_QUARANTINE_REPORTS },
  createLogger('synapset-admin', 'warn'),
);
const now = new Date();

async function account(id: string) {
  const found = await identities.getAccount(id);
  if (!found) fail(`Account ${id} not found`);
  return found;
}

async function run(command: string) {
  switch (command) {
    case 'account create': {
      const id = `acct_${randomBytes(8).toString('hex')}`;
      await identities.saveAccount({
        id,
        name: required('name'),
        plan: plan(),
        status: 'active',
        limitOverrides: {},
        createdAt: now,
      });
      console.log(id);
      return;
    }
    case 'account plan':
      await identities.saveAccount({ ...(await account(required('account'))), plan: plan() });
      return;
    case 'account suspend':
    case 'account resume':
      await identities.saveAccount({
        ...(await account(required('account'))),
        status: command === 'account suspend' ? 'suspended' : 'active',
      });
      return;
    case 'key create': {
      const owner = await account(required('account'));
      const days = values['expires-days'] ? Number(values['expires-days']) : null;
      if (days !== null && !(Number.isInteger(days) && days > 0))
        fail('--expires-days must be a positive integer');
      const { key, keyId, hash } = generateApiKey();
      await identities.saveKey({
        keyId,
        hash,
        accountId: owner.id,
        name: required('name'),
        scopes: scopes(),
        status: 'active',
        createdAt: now,
        expiresAt: days ? new Date(now.getTime() + days * 86_400_000) : null,
        revokedAt: null,
      });
      console.error(`Created key ${keyId}. It is shown once and cannot be recovered:`);
      console.log(key);
      return;
    }
    case 'key list':
      console.table(
        (await identities.listKeys(required('account'))).map(({ hash: _hash, ...key }) => ({
          ...key,
          scopes: key.scopes.join(','),
        })),
      );
      return;
    case 'key revoke':
      if (!(await identities.revokeKey(required('key'), now))) fail('Key not found');
      console.error('Revoked. Running instances stop accepting it within 30 seconds.');
      return;
    case 'feedback list':
      console.table(
        (await assessments.listReports(limit(50))).map((r) => ({
          question: r.questionId.slice(0, 16),
          reason: r.reason,
          reused: r.reused,
          dismissed: r.dismissed,
          account: r.accountId,
          at: r.createdAt.toISOString(),
          comment: r.comment?.slice(0, 60) ?? '',
        })),
      );
      return;
    case 'feedback summary':
      summarize(await assessments.listReports(limit(1000)));
      return;
    case 'question quarantine': {
      const outcome = await feedback.quarantine(required('question'));
      if (outcome.status === 'not_found') fail('Question not found');
      console.error(
        `Quarantined. ${String(outcome.expired)} assessments expired and will be rebuilt on demand.`,
      );
      return;
    }
    case 'question restore': {
      const outcome = await feedback.restore(required('question'), config.ASSESSMENT_TTL_SECONDS);
      if (outcome.status === 'not_found') fail('Question not found');
      console.error(`Restored. ${String(outcome.dismissed)} reports dismissed.`);
      return;
    }
    case 'pool-cap list':
      console.error(`Default: ${String(config.QUESTION_POOL_CAP)}`);
      console.table(await assessments.getPoolCapRules());
      return;
    case 'pool-cap set': {
      const cap = Number(required('cap'));
      if (!(Number.isInteger(cap) && cap >= 1 && cap <= MAX_POOL_CAP))
        fail(`--cap must be an integer from 1 to ${String(MAX_POOL_CAP)}`);
      const dimensions = capDimensions();
      const others = (await assessments.getPoolCapRules()).filter((r) => !sameDimensions(dimensions, r));
      await assessments.savePoolCapRules([...others, { ...dimensions, cap }]);
      console.error(
        'Saved. Live everywhere within 30 seconds. Lowering a cap hides questions, not deletes them.',
      );
      return;
    }
    case 'pool-cap remove': {
      const dimensions = capDimensions();
      const rules = await assessments.getPoolCapRules();
      const others = rules.filter((r) => !sameDimensions(dimensions, r));
      if (others.length === rules.length) fail('No rule has exactly these dimensions');
      await assessments.savePoolCapRules(others);
      return;
    }
    case 'calibrate':
      await calibrate(values.file ?? new URL('../calibration.json', import.meta.url).pathname);
      return;
    default:
      fail(command ? `Unknown command "${command}"` : 'Missing command');
  }
}

function summarize(reports: Awaited<ReturnType<typeof assessments.listReports>>) {
  const open = reports.filter((r) => !r.dismissed);
  console.log(`${String(open.length)} open reports (${String(reports.length - open.length)} dismissed)\n`);
  console.table(
    REPORT_REASONS.map((reason) => ({
      reason,
      reused: open.filter((r) => r.reason === reason && r.reused).length,
      generated: open.filter((r) => r.reason === reason && !r.reused).length,
    })),
  );
  // Off-topic reports on reused questions are the direct signal that the reuse margin is too loose.
  const reused = open.filter((r) => r.reused);
  const offTopic = reused.filter((r) => r.reason === 'off_topic').length;
  if (reused.length > 0) {
    console.log(
      `off_topic share of reused-question reports: ${pct(offTopic / reused.length)}` +
        (offTopic / reused.length > 0.25 ? ' (high: consider raising QUESTION_REUSE_MARGIN)' : ''),
    );
  }
}

interface CalibrationCase {
  topic: string;
  context?: string;
  related: string[];
  unrelated: string[];
}

function parseCases(raw: unknown): CalibrationCase[] {
  const cases = (raw as { cases?: unknown }).cases;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (
    !Array.isArray(cases) ||
    cases.length === 0 ||
    !cases.every(
      (c: Partial<CalibrationCase>) =>
        typeof c.topic === 'string' &&
        (c.context === undefined || typeof c.context === 'string') &&
        strings(c.related) &&
        strings(c.unrelated),
    )
  )
    fail('Calibration file must be {"cases": [{"topic", "context"?, "related": [], "unrelated": []}]}');
  return cases as CalibrationCase[];
}

/**
 * Scores every labelled pair with the live embedding model and the same noise-floor rule the bank uses,
 * then reports precision (reused questions that belong) and recall (belonging questions reused) per margin.
 */
async function calibrate(file: string) {
  const cases = parseCases(JSON.parse(await readFile(file, 'utf8')));
  const embedder = new VertexEmbedder(
    createGenAiClient(config.GCP_PROJECT_ID, config.VERTEX_LOCATION),
    config.EMBEDDING_MODEL,
  );
  const texts = [
    ...BACKGROUND_QUESTIONS,
    ...cases.flatMap((c) => [
      requestText(normalizeTopic(c.topic), cleanContext(c.context)),
      ...c.related,
      ...c.unrelated,
    ]),
  ];
  const vectors = await embedAll(embedder, texts);
  const background = vectors.slice(0, BACKGROUND_QUESTIONS.length);

  const pairs: { excess: number; related: boolean; label: string }[] = [];
  let offset = BACKGROUND_QUESTIONS.length;
  for (const c of cases) {
    const query = vectors[offset++] as number[];
    const floor = noiseFloor(query, background);
    for (const [items, related] of [
      [c.related, true],
      [c.unrelated, false],
    ] as const) {
      for (const text of items) {
        const excess = cosine(query, vectors[offset++] as number[]) - floor;
        pairs.push({ excess, related, label: `${c.topic}${c.context ? ` / ${c.context}` : ''}: ${text}` });
      }
    }
  }

  const rows = Array.from({ length: 11 }, (_, i) => {
    const margin = Math.round(i * 0.02 * 100) / 100;
    const reused = pairs.filter((p) => p.excess >= margin);
    const correct = reused.filter((p) => p.related).length;
    return {
      margin,
      precision: reused.length ? correct / reused.length : 1,
      recall: correct / pairs.filter((p) => p.related).length,
    };
  });
  console.log(`${config.EMBEDDING_MODEL}, ${String(cases.length)} cases, ${String(pairs.length)} pairs\n`);
  console.table(rows.map((r) => ({ margin: r.margin, precision: pct(r.precision), recall: pct(r.recall) })));

  const auto = rows.find((r) => r.precision >= 0.95);
  const strict = rows.find((r) => r.precision >= 1 && r.margin >= (auto?.margin ?? 0));
  console.log(
    `current: QUESTION_REUSE_MARGIN=${String(config.QUESTION_REUSE_MARGIN)} ` +
      `QUESTION_REUSE_STRICT_MARGIN=${String(config.QUESTION_REUSE_STRICT_MARGIN)}`,
  );
  console.log(
    `suggested: QUESTION_REUSE_MARGIN=${auto ? String(auto.margin) : 'none reaches 95% precision'} ` +
      `QUESTION_REUSE_STRICT_MARGIN=${strict ? String(strict.margin) : 'none reaches 100% precision'}`,
  );

  const margin = config.QUESTION_REUSE_MARGIN;
  const wrong = pairs.filter((p) => p.excess >= margin !== p.related);
  if (wrong.length > 0) {
    console.log(`\nMisjudged at the current margin (${String(margin)}):`);
    for (const p of wrong)
      console.log(`  ${p.related ? 'missed  ' : 'reused  '} ${p.excess.toFixed(3)}  ${p.label}`);
  }
}

async function embedAll(embedder: VertexEmbedder, texts: readonly string[]): Promise<number[][]> {
  const vectors = new Array<number[]>(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      vectors[i] = await embedder.embed(texts[i] as string);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return vectors;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

try {
  await run(positionals.slice(0, 2).join(' '));
} finally {
  await firestore.terminate();
}
