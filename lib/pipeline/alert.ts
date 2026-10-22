// 7단계 알림: 등급·갈림길 신호·최고 확률 시나리오 변화를 보고 텔레그램 3줄 브리핑을 보낸다.
// Design Ref: §7.2-3 알림 판정, §7.3 야간 보류 알림 처리.
// PRD Must② 규칙 1: 1·2등급 출처가 1개 이상일 때만, 판정 후 10분 이내. '경계'는 23시~07시면 07시 이후 첫 실행으로 미루고 그때 등급으로 다시 판정.
// PRD Must② 규칙 7~11: 3줄 브리핑(줄당 60자), 재알림 3조건, 같은 등급 재진입은 24시간('심각' 6시간) 안에 다시 보내지 않음,
// '심각' 강조, '심각'에서 내려가면 하향 알림, 면책 문구.

import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { askJson } from "../ai/llm";
import { GRADES, RULES, type Grade } from "../config/rules";
import { SOURCES } from "../config/sources";
import type { Db } from "../db/client";
import { alerts, articles, issueArticles, issues, scenarioSignals, scenarios, scores } from "../db/schema";
import { sendTelegram, telegramReady } from "../telegram";

const TIER_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.tier]));
type AlertKind = (typeof alerts.$inferInsert)["kind"];
const HOUR = 3_600_000;

const rank = (grade: Grade) => GRADES.indexOf(grade);

/** 한국 시간으로 23시~07시인지 */
export function isNightKst(now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hour12: false }).format(now)) % 24;
  const { startHourKst, endHourKst } = RULES.alert.nightHold;
  return hour >= startHourKst || hour < endHourKst;
}

const BriefingSchema = z
  .object({ situation: z.string(), spread: z.string(), caution: z.string() })
  .refine((value) => [value.situation, value.spread, value.caution].every((line) => line.trim().length > 0 && line.length <= RULES.alert.briefingLineMaxChars), {
    message: `세 줄 모두 ${RULES.alert.briefingLineMaxChars}자 이내여야 합니다`,
  });

async function writeBriefing(issue: { title: string; summaryKo: string | null }, scenarioText: string, totals: AlertResult) {
  const result = await askJson({
    tier: "fast",
    schemaName: "three_line_briefing",
    maxTokens: 400,
    system: `리스크 알림용 3줄 브리핑을 한국어로 쓴다. 각 줄은 ${RULES.alert.briefingLineMaxChars}자 이내.
situation: 지금 무슨 일이 있는지 / spread: 앞으로 어떻게 번질 수 있는지 / caution: 무엇을 주의해야 하는지.
주어진 이슈 요약과 시나리오에 있는 내용만 쓰고, 수치를 지어내지 않는다.`,
    prompt: JSON.stringify({ issue: issue.title, summary: issue.summaryKo ?? "", scenarios: scenarioText }),
    schema: BriefingSchema,
  });
  totals.inputTokens += result.usage.inputTokens;
  totals.outputTokens += result.usage.outputTokens;
  return result.data;
}

const KIND_LABEL: Record<AlertKind, string> = {
  신규: "새 경보",
  상향: "등급 상승",
  신호: "갈림길 신호 켜짐",
  "최고 시나리오 변경": "가장 유력한 시나리오 변경",
  "심각 하향": "'심각'에서 하향",
  "기준표 변경": "평가 기준표 변경",
};

function formatMessage(args: {
  kind: AlertKind;
  grade: Grade;
  score: number;
  title: string;
  lines: { situation: string; spread: string; caution: string };
  note?: string;
  issueId: number;
}): string {
  const siteUrl = process.env.SITE_URL?.trim().replace(/\/$/, "");
  return [
    `${args.grade === "심각" ? "[심각] " : ""}아르고스 · ${KIND_LABEL[args.kind]} · ${args.grade} ${Math.round(args.score)}점`,
    args.title,
    "",
    `① ${args.lines.situation}`,
    `② ${args.lines.spread}`,
    `③ ${args.lines.caution}`,
    ...(args.note ? ["", args.note] : []),
    ...(siteUrl ? ["", `${siteUrl}/issues/${args.issueId}`] : []),
    "",
    RULES.alert.disclaimer,
  ].join("\n");
}

export type AlertResult = {
  sent: number;
  held: number;
  discarded: number;
  failed: number;
  previewed: string[];
  inputTokens: number;
  outputTokens: number;
};

type IssueState = { id: number; title: string; summaryKo: string | null; grade: Grade; score: number };

/** 이슈 하나의 알림 사유를 정한다 (없으면 null) */
async function decide(db: Db, issue: IssueState, now: Date): Promise<{ kind: AlertKind; note?: string } | null> {
  const [last] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.issueId, issue.id), eq(alerts.status, "발송")))
    .orderBy(desc(alerts.decidedAt))
    .limit(1);
  const lastGrade = (last?.grade ?? null) as Grade | null;

  // '심각'에서 내려가면 하향 알림 (PRD Must② 규칙 10)
  if (lastGrade === RULES.alert.downgradeAlertFrom && rank(issue.grade) < rank(lastGrade)) return { kind: "심각 하향" };
  if (rank(issue.grade) < rank(RULES.scenario.minGrade)) return null;

  if (!last) return { kind: "신규" };
  if (rank(issue.grade) > rank(lastGrade!)) return { kind: "상향" };

  // 갈림길 신호가 새로 켜졌거나, 가장 높은 확률의 시나리오가 바뀌면 시간 제한 없이 알린다
  const newlyOn = await db
    .select({ indicator: scenarioSignals.indicator, kind: scenarioSignals.scenarioKind })
    .from(scenarioSignals)
    .where(and(eq(scenarioSignals.issueId, issue.id), eq(scenarioSignals.state, "켜짐"), gt(scenarioSignals.stateChangedAt, last.decidedAt)));
  if (newlyOn.length > 0) {
    return { kind: "신호", note: `켜진 신호: ${newlyOn.map((signal) => `${signal.indicator}(${signal.kind})`).join(", ")}` };
  }
  const top = (body: { kind: string; probability: number }[]) => [...body].sort((a, b) => b.probability - a.probability)[0]?.kind;
  const [latest] = await db.select().from(scenarios).where(eq(scenarios.issueId, issue.id)).orderBy(desc(scenarios.version)).limit(1);
  const [atLastAlert] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.issueId, issue.id), lt(scenarios.createdAt, last.decidedAt)))
    .orderBy(desc(scenarios.version))
    .limit(1);
  if (latest && atLastAlert && top(latest.body) !== top(atLastAlert.body)) {
    return { kind: "최고 시나리오 변경", note: `가장 유력한 시나리오: ${top(atLastAlert.body)} → ${top(latest.body)}` };
  }

  // 같은 등급으로 다시 올라온 경우: 마지막 알림 뒤 낮은 등급을 거쳤고, 대기 시간이 지났을 때만
  const cooldown = RULES.alert.sameGradeCooldownHours[issue.grade as "경계" | "심각"] ?? 24;
  if (now.getTime() - last.decidedAt.getTime() < cooldown * HOUR) return null;
  const dipped = await db
    .select({ id: scores.id })
    .from(scores)
    .where(and(eq(scores.issueId, issue.id), gt(scores.createdAt, last.decidedAt), inArray(scores.grade, GRADES.filter((grade) => rank(grade) < rank(issue.grade)))))
    .limit(1);
  return dipped.length ? { kind: "상향", note: "낮은 등급으로 내려갔다가 다시 올라왔어요" } : null;
}

/** 1·2등급 정식 출처가 1개 이상 있는지 (PRD Must② 규칙 1) */
async function hasTier12Source(db: Db, issueId: number): Promise<boolean> {
  const rows = await db
    .select({ sourceId: articles.sourceId })
    .from(issueArticles)
    .innerJoin(articles, eq(articles.id, issueArticles.articleId))
    .where(and(eq(issueArticles.issueId, issueId), eq(articles.isRumor, false), eq(articles.status, "정상")));
  return rows.some((row) => (TIER_BY_SOURCE.get(row.sourceId) ?? 3) <= 2);
}

async function deliver(db: Db, row: { id: number; message: string }, dryRun: boolean, totals: AlertResult, now: Date) {
  if (dryRun) {
    totals.previewed.push(row.message);
    return;
  }
  try {
    await sendTelegram(row.message);
    await db.update(alerts).set({ status: "발송", sentAt: now }).where(eq(alerts.id, row.id));
    totals.sent++;
  } catch (error) {
    // 실패로 남기고 다음 실행 때 다시 보낸다 (DESIGN 10장)
    await db.update(alerts).set({ status: "실패" }).where(eq(alerts.id, row.id));
    totals.failed++;
    console.log(`  ⚠️  알림 ${row.id} ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 알림을 판정하고 보낸다.
 * dryRun이면 저장·발송 없이 보낼 문구만 돌려준다. issueIds·forceKind는 시험용(등급과 관계없이 그 이슈로 문구를 만든다).
 */
export async function runAlerts(
  db: Db,
  options: { now?: Date; dryRun?: boolean; issueIds?: number[]; forceKind?: AlertKind } = {},
): Promise<AlertResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? !telegramReady();
  const night = isNightKst(now);
  const totals: AlertResult = { sent: 0, held: 0, discarded: 0, failed: 0, previewed: [], inputTokens: 0, outputTokens: 0 };

  // ── 1. 보류·실패 알림 정리 (07시 이후 첫 실행, 또는 실패 재시도) ──
  if (!dryRun) {
    const pending = await db
      .select()
      .from(alerts)
      .where(inArray(alerts.status, night ? ["실패"] : ["보류", "실패"]))
      .orderBy(desc(alerts.decidedAt));
    const seen = new Set<number>();
    for (const row of pending) {
      const [issue] = row.issueId ? await db.select().from(issues).where(eq(issues.id, row.issueId)) : [];
      const [laterSent] = row.issueId
        ? await db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.issueId, row.issueId), eq(alerts.status, "발송"), gt(alerts.decidedAt, row.decidedAt))).limit(1)
        : [];
      // 같은 이슈의 보류 알림은 가장 최근 것 하나만, 지금 등급으로 다시 판정한다 (DESIGN 7.3)
      const stale =
        !issue ||
        seen.has(issue.id) ||
        laterSent ||
        (row.kind !== "심각 하향" && rank(issue.grade) < rank(RULES.scenario.minGrade));
      if (stale) {
        await db.update(alerts).set({ status: "폐기" }).where(eq(alerts.id, row.id));
        totals.discarded++;
        continue;
      }
      seen.add(issue.id);
      await deliver(db, row, false, totals, now);
    }
  }

  // ── 2. 새 알림 판정 (등급 높은 순) ──
  const list: IssueState[] = await db
    .select({ id: issues.id, title: issues.title, summaryKo: issues.summaryKo, grade: issues.grade, score: issues.score })
    .from(issues)
    .where(and(eq(issues.mode, "live"), eq(issues.status, "진행 중"), options.issueIds ? inArray(issues.id, options.issueIds) : undefined));
  list.sort((a, b) => rank(b.grade) - rank(a.grade) || b.score - a.score);

  for (const issue of list) {
    try {
      const decision = options.forceKind ? { kind: options.forceKind } : await decide(db, issue, now);
      if (!decision) continue;
      if (!(await hasTier12Source(db, issue.id))) continue;

      const [latest] = await db.select().from(scenarios).where(eq(scenarios.issueId, issue.id)).orderBy(desc(scenarios.version)).limit(1);
      const scenarioText = latest
        ? latest.body.map((item) => `${item.kind} ${item.probability}%: ${item.path}`).join("\n")
        : "아직 시나리오 없음";
      const lines = await writeBriefing(issue, scenarioText, totals);
      const message = formatMessage({ kind: decision.kind, grade: issue.grade, score: issue.score, title: issue.title, lines, note: decision.note, issueId: issue.id });

      if (dryRun) {
        totals.previewed.push(message);
        continue;
      }
      // '경계' 알림은 밤에는 보류, '심각'과 하향 알림은 즉시
      const hold = night && issue.grade === RULES.alert.nightHold.appliesTo && decision.kind !== "심각 하향";
      const [row] = await db
        .insert(alerts)
        .values({ issueId: issue.id, kind: decision.kind, grade: issue.grade, status: hold ? "보류" : "실패", decidedAt: now, message })
        .returning({ id: alerts.id });
      if (hold) totals.held++;
      else await deliver(db, { id: row.id, message }, false, totals, now);
    } catch (error) {
      totals.failed++;
      console.log(`  ⚠️  이슈 ${issue.id} 알림 판정 실패: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
    }
  }
  return totals;
}
