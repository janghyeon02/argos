// 6단계 시나리오: '경계' 이상 이슈의 기본·악화·극단 시나리오를 만들고, 새 기사가 들어오면 갱신한다.
// Design Ref: §7.2-2 — 갱신 때는 기존 갈림길 신호의 고정 번호 목록을 넘겨 상태만 바꾸게 하고, 새 신호는 새 번호로 추가한다.
// PRD Must② 규칙 2~6: 시나리오 3개, 1% 단위 확률 합 100, 갈림길 신호 시나리오마다 2개 이상(지표·조건·논리),
// 한국 영향은 영향 경로 점수 2점 이상인 경로만, 점검 사항 3~5개. 바뀐 확률과 이유는 버전으로 남긴다.

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { askJson } from "../ai/llm";
import { GRADES, IMPACT_CHANNELS, RULES, type Grade } from "../config/rules";
import { SOURCES } from "../config/sources";
import type { Db } from "../db/client";
import { articles, issueArticles, issues, scenarioSignals, scenarios, scores, type ScenarioBody } from "../db/schema";

const NAME_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.name]));
const TIER_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.tier]));
const KINDS = RULES.scenario.kinds;

const SYSTEM = `너는 한국 경제에 영향을 줄 수 있는 국내외 리스크 이슈의 전개 시나리오를 쓰는 분석가다.
주어진 이슈와 기사(제목·한국어 요약)만 근거로, 기본·악화·극단 세 시나리오를 한국어로 쓴다.

규칙:
- scenarios: "기본", "악화", "극단" 세 개. probability는 1% 단위 정수이고 세 값의 합은 정확히 100이다.
  확률 크기에 순서 제한은 없다 — 상황이 극단으로 흐르고 있으면 극단이 가장 높을 수 있다.
- path: 그 시나리오가 어떻게 전개되는지 2~3문장.
- korea_impact: 한국으로 들어오는 경로별 영향. channel은 아래 허용 경로 중에서만 고르고, direction은 악영향 "↓" / 호재 "↑", size는 "소"·"중"·"대".
- checklist: 지금 확인하고 대비할 점검 사항 ${RULES.scenario.checklistMin}~${RULES.scenario.checklistMax}개. 바로 행동할 수 있는 문장으로.
- signals: 각 시나리오 안의 signals 배열에 그 시나리오의 갈림길 신호를 반드시 ${RULES.scenario.minSignalsPerScenario}~4개 넣는다.
  indicator는 확인 가능한 구체적 지표·사건(예: "영국 30년물 국채 금리 5% 돌파"), condition은 판단 조건,
  rationale은 그 신호가 왜 그 시나리오로 이어지는지 한 줄, state는 기사로 보아 이미 일어났으면 "켜짐" 아니면 "꺼짐".
- 기존 신호 목록이 주어지면, 그대로 이어 쓸 신호는 같은 id를 넣고 state만 최신 기사에 맞게 고친다. 새 신호는 id를 0으로 둔다.
- change_reason: 직전 시나리오와 비교해 확률·신호가 바뀐 이유 한두 문장(처음이면 "처음 작성").
- evidence: 판단의 근거가 된 기사 id 목록.
- 기사에 없는 사실·수치를 지어내지 않는다.`;

const SignalSchema = z.object({
  id: z.number().int(),
  indicator: z.string().min(1),
  condition: z.string().min(1),
  rationale: z.string().min(1),
  state: z.enum(["켜짐", "꺼짐"]),
});

const ScenarioSchema = z.object({
  kind: z.enum(KINDS),
  probability: z.number().int().min(0).max(100),
  path: z.string().min(1),
  korea_impact: z.array(
    z.object({ channel: z.enum(IMPACT_CHANNELS), direction: z.enum(["↑", "↓"]), size: z.enum(["소", "중", "대"]) }),
  ),
  checklist: z.array(z.string().min(1)),
  signals: z.array(SignalSchema),
});

const ResultSchema = z
  .object({
    scenarios: z.array(ScenarioSchema),
    change_reason: z.string(),
    evidence: z.array(z.number().int()),
  })
  .refine((value) => KINDS.every((kind) => value.scenarios.filter((item) => item.kind === kind).length === 1), {
    message: "시나리오는 기본·악화·극단 하나씩이어야 합니다",
  })
  .refine((value) => value.scenarios.reduce((sum, item) => sum + item.probability, 0) === RULES.scenario.probabilityTotal, {
    message: "확률의 합이 100이어야 합니다",
  })
  .refine(
    (value) =>
      value.scenarios.every((item) => item.signals.length >= RULES.scenario.minSignalsPerScenario),
    { message: `시나리오마다 갈림길 신호가 ${RULES.scenario.minSignalsPerScenario}개 이상이어야 합니다` },
  )
  .refine(
    (value) =>
      value.scenarios.every(
        (item) => item.checklist.length >= RULES.scenario.checklistMin && item.checklist.length <= RULES.scenario.checklistMax,
      ),
    { message: `점검 사항은 ${RULES.scenario.checklistMin}~${RULES.scenario.checklistMax}개여야 합니다` },
  );

export type ScenarioResult = { created: number; updated: number; skipped: number; failed: number; inputTokens: number; outputTokens: number };

type Target = { id: number; title: string; summaryKo: string | null; grade: Grade };

function atLeast(grade: Grade, minimum: Grade): boolean {
  return GRADES.indexOf(grade) >= GRADES.indexOf(minimum);
}

async function buildScenario(db: Db, issue: Target, now: Date, totals: ScenarioResult, force: boolean): Promise<void> {
  const [previous] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.issueId, issue.id), eq(scenarios.mode, "live")))
    .orderBy(desc(scenarios.version))
    .limit(1);

  const linked = await db
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

  // 새 기사가 없으면 그대로 둔다 (막 '경계'가 되었거나 시나리오가 없으면 만든다)
  const hasNew = !previous || linked.some((row) => row.linkedAt > previous.createdAt);
  if (!hasNew && !force) {
    totals.skipped++;
    return;
  }

  const existingSignals = await db.select().from(scenarioSignals).where(eq(scenarioSignals.issueId, issue.id));
  const [score] = await db.select().from(scores).where(eq(scores.issueId, issue.id)).orderBy(desc(scores.createdAt)).limit(1);
  const channelMedian = score?.channelScores?.median ?? {};
  const allowedChannels = IMPACT_CHANNELS.filter((channel) => (channelMedian[channel] ?? 0) >= RULES.impact.koreaImpactMinChannelScore);

  const result = await askJson({
    tier: "deep",
    schemaName: "issue_scenarios",
    maxTokens: 3000,
    system: SYSTEM,
    prompt: JSON.stringify({
      as_of: now.toISOString(),
      issue: { title: issue.title, summary: issue.summaryKo ?? "", grade: issue.grade },
      allowed_korea_impact_channels: allowedChannels.length ? allowedChannels : IMPACT_CHANNELS,
      previous_scenarios: previous?.body ?? null,
      existing_signals: existingSignals.map((signal) => ({
        id: signal.id,
        scenario_kind: signal.scenarioKind,
        indicator: signal.indicator,
        condition: signal.condition,
        state: signal.state,
      })),
      articles: linked.slice(0, 30).map((row) => ({
        id: row.id,
        source: NAME_BY_SOURCE.get(row.sourceId) ?? row.sourceId,
        tier: TIER_BY_SOURCE.get(row.sourceId) ?? 3,
        rumor: row.isRumor,
        status: row.status,
        published_at: row.publishedAt.toISOString(),
        title: row.title,
        summary: row.summaryKo ?? "",
      })),
    }),
    schema: ResultSchema,
  });
  totals.inputTokens += result.usage.inputTokens;
  totals.outputTokens += result.usage.outputTokens;

  // 한국 영향은 점수 2점 이상인 경로만 남긴다 (PRD Must② 규칙 5)
  const allowed = new Set(allowedChannels);
  const body: ScenarioBody[] = KINDS.map((kind) => {
    const item = result.data.scenarios.find((scenario) => scenario.kind === kind)!;
    return {
      kind,
      probability: item.probability,
      path: item.path,
      koreaImpact: item.korea_impact.filter((impact) => allowed.size === 0 || allowed.has(impact.channel)),
      checklist: item.checklist,
    };
  });
  const usable = new Set(linked.filter((row) => !row.isRumor && row.status === "정상").map((row) => row.id));

  await db.insert(scenarios).values({
    issueId: issue.id,
    version: (previous?.version ?? 0) + 1,
    body,
    changeReason: result.data.change_reason,
    evidenceArticleIds: [...new Set(result.data.evidence)].filter((id) => usable.has(id)),
    mode: "live",
  });

  // 갈림길 신호: 기존 번호는 상태만 갱신하고, 새 신호는 새 번호로 넣는다 (고정 번호 유지)
  const existingById = new Map(existingSignals.map((signal) => [signal.id, signal]));
  const signals = result.data.scenarios.flatMap((item) => item.signals.map((signal) => ({ ...signal, scenario_kind: item.kind })));
  for (const signal of signals) {
    const existing = signal.id > 0 ? existingById.get(signal.id) : undefined;
    if (existing) {
      if (existing.state !== signal.state) {
        await db.update(scenarioSignals).set({ state: signal.state, stateChangedAt: now }).where(eq(scenarioSignals.id, existing.id));
      }
    } else {
      await db.insert(scenarioSignals).values({
        issueId: issue.id,
        scenarioKind: signal.scenario_kind,
        indicator: signal.indicator,
        condition: signal.condition,
        rationale: signal.rationale,
        state: signal.state,
        stateChangedAt: now,
      });
    }
  }

  if (previous) totals.updated++;
  else totals.created++;
}

/**
 * '경계' 이상인 진행 중 이슈의 시나리오를 만들거나 갱신한다.
 * issueIds를 주면 등급과 관계없이 그 이슈만 만든다 (시험용).
 */
export async function buildScenarios(db: Db, options: { now?: Date; issueIds?: number[]; force?: boolean } = {}): Promise<ScenarioResult> {
  const now = options.now ?? new Date();
  const list: Target[] = await db
    .select({ id: issues.id, title: issues.title, summaryKo: issues.summaryKo, grade: issues.grade })
    .from(issues)
    .where(
      and(
        eq(issues.mode, "live"),
        eq(issues.status, "진행 중"),
        options.issueIds ? inArray(issues.id, options.issueIds) : undefined,
      ),
    );
  const targets = options.issueIds ? list : list.filter((issue) => atLeast(issue.grade, RULES.scenario.minGrade));

  const totals: ScenarioResult = { created: 0, updated: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  // 등급이 높은 이슈부터 처리한다 (DESIGN 7.2)
  targets.sort((a, b) => GRADES.indexOf(b.grade) - GRADES.indexOf(a.grade));
  for (const issue of targets) {
    try {
      await buildScenario(db, issue, now, totals, options.force ?? false);
    } catch (error) {
      totals.failed++;
      console.log(`  ⚠️  이슈 ${issue.id} 「${issue.title}」 시나리오 실패: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  return totals;
}
