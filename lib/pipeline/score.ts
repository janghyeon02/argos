// 5단계 점수화: 이슈마다 영향도·가능성·속도와 종합 점수·등급을 매긴다.
// Design Ref: §6 평가 기준표 v1, §6.4 종합 점수 계산 순서, §7.2 이슈 하나의 처리 순서(1. 점수 다시 계산).
// PRD Must① 규칙 1·4: 현재 기준표로 5번 평가해 중앙값, 근거 없는 축 0점, "(카더라)"·철회 자료는 근거 제외,
// 1·2등급 근거가 없으면 '심각' 불가(79점). PRD 3-2: 등급 하향은 연속 2회 확인 후.
// 매 실행마다 진행 중인 모든 이슈의 속도와 종합 점수를 다시 계산하고, AI 평가는 새 자료가 생긴 이슈만 한다.

import { readFileSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { askJsonSamples } from "../ai/llm";
import { GRADES, IMPACT_CHANNELS, RULES, type Grade, type ImpactChannel } from "../config/rules";
import { SOURCES } from "../config/sources";
import type { Db } from "../db/client";
import { articles, issueArticles, issues, rubricVersions, scores, type ScoreEvidence } from "../db/schema";

const TIER_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.tier]));
const NAME_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.name]));
const RUBRIC_VERSION = 1;
const HOUR = 3_600_000;

// ── 계산 규칙 (AI 없이) ──────────────────────────────────────

/** 영향도 = 최고 경로 × 14 + 나머지 합 × 2 (+ 시스템 중요국 가산점), 최대 100 */
export function impactScore(channels: Record<ImpactChannel, number>, systemic: boolean): number {
  const values = IMPACT_CHANNELS.map((channel) => Math.max(0, Math.min(RULES.impact.channelMax, channels[channel] ?? 0)));
  const top = Math.max(...values);
  const rest = values.reduce((sum, value) => sum + value, 0) - top;
  const base = Math.min(RULES.scoring.axisMax, top * RULES.impact.topChannelWeight + rest * RULES.impact.otherChannelWeight);
  return Math.min(RULES.scoring.axisMax, base + (systemic && top > 0 ? RULES.impact.systemicBonus : 0));
}

/** 가능성 = 압력(0~40) + 예정된 계기(0/10/20/30) + 촉발 신호(10점씩, 최대 30) */
export function likelihoodScore(pressure: number, scheduledDays: number | null, signals: number): number {
  const pressurePart = Math.max(0, Math.min(RULES.likelihood.pressureMax, pressure));
  const scheduled =
    scheduledDays === null || scheduledDays < 0
      ? 0
      : (RULES.likelihood.scheduledTrigger.find((rule) => scheduledDays <= rule.withinDays)?.score ?? 0);
  const signalPart = Math.min(RULES.likelihood.triggerSignalMax, Math.max(0, signals) * RULES.likelihood.triggerSignalScore);
  return pressurePart + scheduled + signalPart;
}

/** 속도: 최근 6시간 가중 자료 수 ÷ 직전 7일 6시간 평균(최소 1)을 환산표로 바꾼다 */
export function velocityScore(recentWeighted: number, baselineWeighted: number): number {
  const windows = (RULES.velocity.baselineDays * 24) / RULES.velocity.windowHours;
  const baseline = Math.max(RULES.velocity.baselineMin, baselineWeighted / windows);
  const ratio = recentWeighted / baseline;
  const score = RULES.velocity.ratioToScore.find((step) => ratio < step.upTo)?.score ?? 100;
  return recentWeighted < RULES.velocity.minCountForHighScore ? Math.min(score, RULES.velocity.lowCountMaxScore) : score;
}

export function gradeOf(score: number): Grade {
  return [...GRADES].reverse().find((grade) => score >= RULES.grade.minScore[grade]) ?? "관심";
}

export function isBorderline(score: number): boolean {
  return GRADES.slice(1).some((grade) => Math.abs(score - RULES.grade.minScore[grade]) <= RULES.grade.borderlineMargin);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── AI 평가 ──────────────────────────────────────────────────

const ChannelSchema = z.object(
  Object.fromEntries(IMPACT_CHANNELS.map((channel) => [channel, z.number().int().min(0).max(5)])) as Record<
    ImpactChannel,
    z.ZodNumber
  >,
);

const EvaluationSchema = z.object({
  channels: ChannelSchema,
  systemic_origin: z.boolean(),
  impact_evidence: z.array(z.number().int()),
  pressure: z.number().int().min(0).max(40),
  scheduled_trigger_days: z.number().int().nullable(),
  trigger_signals: z.number().int().min(0).max(3),
  likelihood_evidence: z.array(z.number().int()),
});
type Evaluation = z.infer<typeof EvaluationSchema>;

let rubricText: string | null = null;
function rubric(): string {
  rubricText ??= readFileSync(path.join(process.cwd(), "rubric", `v${RUBRIC_VERSION}.md`), "utf8");
  return rubricText;
}

function systemPrompt(): string {
  return `너는 한국 경제에 영향을 줄 수 있는 국내외 리스크 이슈를 평가 기준표에 따라 채점하는 분석가다.
아래 평가 기준표의 1장(영향도)과 2장(가능성)만 채점한다. 속도는 따로 계산하므로 채점하지 않는다.

규칙:
- 주어진 기사(제목·한국어 요약)에 실제로 나온 내용만 근거로 쓴다. 기사에 없는 사실·수치를 짐작해 점수를 올리지 않는다.
- impact_evidence, likelihood_evidence에는 각 축 점수의 근거가 된 기사 id를 넣는다. 근거 기사가 없으면 빈 배열로 두고 그 축은 낮게 준다.
- systemic_origin: 이슈의 진원이 미국·중국·유로존·일본이거나 한국 자체면 true.
- scheduled_trigger_days: 기사에 나온 예정된 결정·발표·표결·선거까지 남은 날 수(기준 시각 기준). 없으면 null.
- trigger_signals: 기사에 실제로 나온 촉발 신호 개수(0~3).

=== 평가 기준표 ===
${rubric()}`;
}

type IssueArticle = {
  id: number;
  sourceId: string;
  title: string;
  summaryKo: string | null;
  isRumor: boolean;
  status: string;
  publishedAt: Date;
  /** 이 이슈에 연결된 시각 */
  linkedAt: Date;
};

/** AI 근거에서 쓸 수 없는 기사(없는 번호, "(카더라)", 정정·철회)를 뺀다 */
function cleanEvidence(ids: number[], usable: Map<number, IssueArticle>): number[] {
  return [...new Set(ids)].filter((id) => usable.has(id));
}

/** 5번 평가 중 하나를 점수로 바꾼다 — 근거 없는 축은 0점 */
function toAxes(evaluation: Evaluation, usable: Map<number, IssueArticle>) {
  const impactEvidence = cleanEvidence(evaluation.impact_evidence, usable);
  const likelihoodEvidence = cleanEvidence(evaluation.likelihood_evidence, usable);
  return {
    channels: evaluation.channels,
    systemic: evaluation.systemic_origin,
    impact: impactEvidence.length ? impactScore(evaluation.channels, evaluation.systemic_origin) : RULES.scoring.noEvidenceAxisScore,
    likelihood: likelihoodEvidence.length
      ? likelihoodScore(evaluation.pressure, evaluation.scheduled_trigger_days, evaluation.trigger_signals)
      : RULES.scoring.noEvidenceAxisScore,
    impactEvidence,
    likelihoodEvidence,
  };
}

// ── 이슈 하나 채점 ───────────────────────────────────────────

export type ScoreResult = {
  scored: number;
  evaluated: number;
  reused: number;
  failed: number;
  gradeCounts: Record<Grade, number>;
  inputTokens: number;
  outputTokens: number;
};

type IssueRow = { id: number; title: string; summaryKo: string | null; grade: Grade; pendingDowngradeRuns: number };

async function scoreIssue(db: Db, issue: IssueRow, now: Date, totals: ScoreResult): Promise<void> {
  const linked: IssueArticle[] = await db
    .select({
      id: articles.id,
      sourceId: articles.sourceId,
      title: articles.title,
      summaryKo: articles.summaryKo,
      isRumor: articles.isRumor,
      status: articles.status,
      publishedAt: articles.publishedAt,
      linkedAt: issueArticles.createdAt,
    })
    .from(issueArticles)
    .innerJoin(articles, eq(articles.id, issueArticles.articleId))
    .where(eq(issueArticles.issueId, issue.id))
    .orderBy(desc(articles.publishedAt));
  if (linked.length === 0) return;

  // 근거로 쓸 수 있는 기사: "(카더라)"가 아니고 정정·철회되지 않은 기사
  const usable = new Map(linked.filter((row) => !row.isRumor && row.status === "정상").map((row) => [row.id, row]));

  // ── 속도 (AI 없이) ──
  const weight = (row: IssueArticle) => (row.isRumor ? RULES.velocity.rumorWeight : RULES.velocity.tierWeight[TIER_BY_SOURCE.get(row.sourceId) ?? 3]);
  const windowStart = now.getTime() - RULES.velocity.windowHours * HOUR;
  const baselineStart = windowStart - RULES.velocity.baselineDays * 24 * HOUR;
  let recent = 0;
  let baseline = 0;
  for (const row of linked) {
    const t = row.publishedAt.getTime();
    if (t > now.getTime()) continue;
    if (t >= windowStart) recent += weight(row);
    else if (t >= baselineStart) baseline += weight(row);
  }
  const velocity = velocityScore(recent, baseline);

  // ── 영향도·가능성: 마지막 채점 뒤 새 기사가 있으면 AI로 5번 평가, 없으면 직전 평가를 다시 쓴다 ──
  const [last] = await db
    .select()
    .from(scores)
    .where(and(eq(scores.issueId, issue.id), eq(scores.mode, "live"), eq(scores.reusedEvaluation, false)))
    .orderBy(desc(scores.createdAt))
    .limit(1);
  const needsEvaluation = !last || linked.some((row) => row.linkedAt > last.createdAt);

  let runs: ReturnType<typeof toAxes>[];
  let reused = false;
  if (needsEvaluation || !last) {
    const shown = linked.slice(0, 30).map((row) => ({
      id: row.id,
      source: NAME_BY_SOURCE.get(row.sourceId) ?? row.sourceId,
      tier: TIER_BY_SOURCE.get(row.sourceId) ?? 3,
      rumor: row.isRumor,
      status: row.status,
      published_at: row.publishedAt.toISOString(),
      title: row.title,
      summary: row.summaryKo ?? "",
    }));
    const result = await askJsonSamples(
      {
        tier: "fast",
        schemaName: "issue_evaluation",
        maxTokens: 600,
        system: systemPrompt(),
        prompt: JSON.stringify({ as_of: now.toISOString(), issue: { title: issue.title, summary: issue.summaryKo ?? "" }, articles: shown }),
        schema: EvaluationSchema,
      },
      RULES.scoring.evaluationRuns,
    );
    totals.inputTokens += result.usage.inputTokens;
    totals.outputTokens += result.usage.outputTokens;
    runs = result.data.map((evaluation) => toAxes(evaluation, usable));
    totals.evaluated++;
  } else {
    // 직전 평가의 5번 값을 그대로 쓰고 속도만 새로 계산한다
    const previous = last.channelScores?.runs ?? [];
    runs = previous.map((channels, index) => ({
      channels: channels as Record<ImpactChannel, number>,
      systemic: last.systemicBonus > 0,
      impact: last.impactRuns?.[index] ?? last.impact,
      likelihood: last.likelihoodRuns?.[index] ?? last.likelihood,
      impactEvidence: last.evidence?.impact ?? [],
      likelihoodEvidence: last.evidence?.likelihood ?? [],
    }));
    reused = true;
    totals.reused++;
  }

  // ── 종합 점수: 5번 각각 계산 → 중앙값 → 상한 → 등급 (DESIGN 6.4) ──
  const composites = runs.map((run) => (run.impact * Math.max(run.likelihood, velocity)) / 100);
  let composite = Math.round(median(composites) * 10) / 10;
  const evidenceIds = new Set(runs.flatMap((run) => [...run.impactEvidence, ...run.likelihoodEvidence]));
  const hasTier12Evidence = [...evidenceIds].some((id) => (TIER_BY_SOURCE.get(usable.get(id)?.sourceId ?? "") ?? 3) <= 2);
  if (!hasTier12Evidence) composite = Math.min(composite, RULES.grade.tier3OnlyMaxScore);

  // 등급 하향은 연속 실행 2번 모두 낮게 나와야 반영한다
  const computed = gradeOf(composite);
  const lower = GRADES.indexOf(computed) < GRADES.indexOf(issue.grade);
  const pending = lower ? issue.pendingDowngradeRuns + 1 : 0;
  const grade = lower && pending < RULES.grade.downgradeConfirmRuns ? issue.grade : computed;

  const medianChannels = Object.fromEntries(
    IMPACT_CHANNELS.map((channel) => [channel, median(runs.map((run) => run.channels[channel] ?? 0))]),
  );
  const evidence: ScoreEvidence = {
    impact: [...new Set(runs.flatMap((run) => run.impactEvidence))],
    likelihood: [...new Set(runs.flatMap((run) => run.likelihoodEvidence))],
    velocity: { weightedCount: recent, baseline },
  };

  await db.insert(scores).values({
    issueId: issue.id,
    rubricVersion: RUBRIC_VERSION,
    channelScores: { runs: runs.map((run) => run.channels), median: medianChannels },
    systemicBonus: runs.filter((run) => run.systemic).length * 2 > runs.length ? RULES.impact.systemicBonus : 0,
    impact: median(runs.map((run) => run.impact)),
    likelihood: median(runs.map((run) => run.likelihood)),
    velocity,
    impactRuns: runs.map((run) => run.impact),
    likelihoodRuns: runs.map((run) => run.likelihood),
    compositeRuns: composites,
    composite,
    grade: computed,
    isBorderline: isBorderline(composite),
    reusedEvaluation: reused,
    evidence,
    mode: "live",
  });
  await db
    .update(issues)
    .set({
      grade,
      score: composite,
      isBorderline: isBorderline(composite),
      pendingDowngradeRuns: lower && pending < RULES.grade.downgradeConfirmRuns ? pending : 0,
      updatedAt: now,
    })
    .where(eq(issues.id, issue.id));

  totals.scored++;
  totals.gradeCounts[grade]++;
}

/** 평가 기준표 v1을 rubric_versions 표에 등록한다 (없을 때만) */
async function ensureRubric(db: Db): Promise<void> {
  await db
    .insert(rubricVersions)
    .values({ version: RUBRIC_VERSION, content: rubric(), applied: true, appliedAt: new Date() })
    .onConflictDoNothing();
}

/** 진행 중인 실제 이슈를 모두 채점한다. 이슈 하나가 실패해도 나머지는 계속한다. */
export async function scoreIssues(db: Db, options: { now?: Date; issueIds?: number[]; concurrency?: number } = {}): Promise<ScoreResult> {
  const now = options.now ?? new Date();
  await ensureRubric(db);
  const recentSince = new Date(now.getTime() - RULES.collection.maxArticleAgeDays * 24 * HOUR);
  const list: IssueRow[] = await db
    .select({ id: issues.id, title: issues.title, summaryKo: issues.summaryKo, grade: issues.grade, pendingDowngradeRuns: issues.pendingDowngradeRuns })
    .from(issues)
    .where(
      and(
        eq(issues.mode, "live"),
        eq(issues.status, "진행 중"),
        gte(issues.lastArticleAt, recentSince),
        options.issueIds ? inArray(issues.id, options.issueIds) : undefined,
      ),
    );

  const totals: ScoreResult = {
    scored: 0,
    evaluated: 0,
    reused: 0,
    failed: 0,
    gradeCounts: { 관심: 0, 주의: 0, 경계: 0, 심각: 0 },
    inputTokens: 0,
    outputTokens: 0,
  };
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const issue = list[next++];
      try {
        await scoreIssue(db, issue, now, totals);
      } catch (error) {
        totals.failed++;
        console.log(`  ⚠️  이슈 ${issue.id} 「${issue.title}」 채점 실패 — 평가 보류: ${(error instanceof Error ? error.message : String(error)).slice(0, 140)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? RULES.enrich.concurrency, list.length) }, worker));
  return totals;
}
