// 과거 사례 검증: 자료 묶음을 기준 시각을 옮겨 가며 다시 돌리고, 경보가 언제 울렸을지 잰다.
// Design Ref: §7.5 — 기준 시각까지 공개된 자료만으로 요약·묶기·점수를 반복(알림은 보내지 않음),
// 선행 시간·놓침·오경보를 계산해 backtest_results에 남긴다. 검증 데이터는 mode=backtest와 실행 번호로 실제 데이터와 분리한다.

import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { embed, similarity } from "../ai/llm";
import { GRADES, RULES, type Grade } from "../config/rules";
import { SOURCES } from "../config/sources";
import type { Db } from "../db/client";
import { articles, backtestResults, issues, runs } from "../db/schema";
import { cluster } from "./cluster";
import { enrich } from "./enrich";
import { inScope, type RunScope } from "./scope";
import { scoreIssues } from "./score";
import type { BacktestCase } from "../config/backtest-cases";
export { loadCases, type BacktestCase } from "../config/backtest-cases";

const HOUR = 3_600_000;
const SOURCE_IDS = new Set(SOURCES.map((source) => source.id));
const LANGUAGE: Record<string, string> = { English: "en", Korean: "ko", Japanese: "ja", German: "de", French: "fr", Italian: "it" };

type BundleArticle = { title: string; url: string; seenAt: string; sourceId: string; language: string };

export type StepSnapshot = { at: string; score: number; grade: Grade; issueId: number | null; title: string | null };

export type CaseOutcome = {
  key: string;
  runId: number;
  articles: number;
  steps: number;
  /** 사례와 관련된 이슈 중 시간대별 최고 점수 */
  timeline: StepSnapshot[];
  firstReached: Partial<Record<Grade, string>>;
  targetResults: { label: string; grade: Grade; by: string; reachedAt: string | null; met: boolean }[];
  /** T0보다 '경계'가 몇 시간 먼저 울렸는지 (음수면 T0 뒤) */
  leadTimeHours: number | null;
  missed: boolean | null;
  /** 평온 기간: '경계' 이상이 된 이슈 수 */
  falseAlarms: number | null;
  costUsd: number;
};

function loadBundle(key: string): BundleArticle[] {
  const file = path.join("data/backtest", key, "articles.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { articles: BundleArticle[] }).articles;
}

const rank = (grade: Grade) => GRADES.indexOf(grade);

/**
 * 사례 하나를 검증한다.
 * stepHours마다 기준 시각을 옮기며 그 시각까지의 자료로 요약 → 묶기 → 점수를 돌린다.
 */
export async function runCase(db: Db, entry: BacktestCase, options: { stepHours?: number; log?: (line: string) => void } = {}): Promise<CaseOutcome> {
  const log = options.log ?? (() => {});
  const stepHours = options.stepHours ?? 3;
  const bundle = loadBundle(entry.key).filter((item) => SOURCE_IDS.has(item.sourceId));
  const start = new Date(entry.window.start);
  const end = new Date(entry.window.end);

  // 1. 검증 실행 기록과 자료 넣기 (실제 데이터와 섞이지 않게 mode=backtest, 실행 번호)
  const [run] = await db.insert(runs).values({ mode: "backtest", startedAt: new Date(), asOf: end, rubricVersion: 1 }).returning({ id: runs.id });
  const scope: RunScope = { mode: "backtest", runId: run.id };
  for (let i = 0; i < bundle.length; i += 500) {
    await db
      .insert(articles)
      .values(
        bundle.slice(i, i + 500).map((item) => ({
          sourceId: item.sourceId,
          url: item.url,
          title: item.title,
          publishedAt: new Date(item.seenAt),
          fetchedAt: new Date(item.seenAt),
          language: LANGUAGE[item.language] ?? "en",
          mode: "backtest" as const,
          backtestRunId: run.id,
        })),
      )
      .onConflictDoNothing();
  }
  log(`  ${entry.key}: 검증 실행 #${run.id}, 자료 ${bundle.length}건`);

  // 2. 기준 시각을 옮기며 반복 — 기준선을 위해 시작 후 하루 뒤부터 잰다
  const snapshots: { at: Date; rows: { id: number; title: string; summaryKo: string | null; grade: Grade; score: number }[] }[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let steps = 0;
  for (let t = start.getTime() + 24 * HOUR; t <= end.getTime(); t += stepHours * HOUR) {
    const now = new Date(t);
    const enriched = await enrich(db, 5000, { scope, until: now });
    const clustered = await cluster(db, 5000, now, scope);
    const scored = await scoreIssues(db, { now, scope });
    tokensIn += enriched.inputTokens + clustered.inputTokens + scored.inputTokens;
    tokensOut += enriched.outputTokens + clustered.outputTokens + scored.outputTokens;
    const rows = await db
      .select({ id: issues.id, title: issues.title, summaryKo: issues.summaryKo, grade: issues.grade, score: issues.score })
      .from(issues)
      .where(and(inScope(issues, scope), eq(issues.status, "진행 중")));
    snapshots.push({ at: now, rows });
    steps++;
    const top = [...rows].sort((a, b) => b.score - a.score)[0];
    if (steps % 4 === 0) log(`  ${entry.key}: ${now.toISOString().slice(0, 13)}시 — 이슈 ${rows.length}개, 최고 ${top ? `${top.grade} ${top.score} 「${top.title}」` : "-"}`);
  }

  // 3. 사례와 관련된 이슈 찾기 (평가에만 쓰는 사후 기준 — 탐지에는 쓰지 않는다)
  const finalIssues = snapshots.at(-1)?.rows ?? [];
  let related = new Set<number>();
  if (entry.description && finalIssues.length > 0) {
    const embedded = await embed([entry.description, ...finalIssues.map((issue) => `${issue.title}\n${issue.summaryKo ?? ""}`)]);
    related = new Set(finalIssues.filter((_, index) => similarity(embedded.vectors[0], embedded.vectors[index + 1]) >= 0.4).map((issue) => issue.id));
  }

  const timeline: StepSnapshot[] = snapshots.map(({ at, rows }) => {
    const pool = entry.description ? rows.filter((row) => related.has(row.id)) : rows;
    const best = [...pool].sort((a, b) => b.score - a.score)[0];
    return { at: at.toISOString(), score: best?.score ?? 0, grade: best?.grade ?? "관심", issueId: best?.id ?? null, title: best?.title ?? null };
  });

  const firstReached: Partial<Record<Grade, string>> = {};
  for (const grade of GRADES.slice(1)) {
    const hit = timeline.find((step) => rank(step.grade) >= rank(grade));
    if (hit) firstReached[grade] = hit.at;
  }

  const targetResults = (entry.targets ?? []).map((target) => {
    const reachedAt = firstReached[target.grade] ?? null;
    return { ...target, reachedAt, met: reachedAt !== null && new Date(reachedAt) <= new Date(target.by) };
  });

  const t0 = entry.t0 ? new Date(entry.t0) : null;
  const warnAt = firstReached["경계"] ? new Date(firstReached["경계"]) : null;
  const leadTimeHours = t0 && warnAt ? Math.round(((t0.getTime() - warnAt.getTime()) / HOUR) * 10) / 10 : null;
  const missed = t0 ? !(warnAt && warnAt.getTime() <= t0.getTime() + RULES.validation.missWithinHoursAfterT0 * HOUR) : null;

  // 평온 기간: '경계' 이상이 된 적 있는 이슈 수를 오경보로 센다 (실제 영향 여부는 labels.json으로 나중에 보정)
  const falseAlarms = entry.description
    ? null
    : new Set(snapshots.flatMap(({ rows }) => rows.filter((row) => rank(row.grade) >= rank("경계")).map((row) => row.id))).size;

  const { input, output } = RULES.ai.pricePerMillionTokens;
  const costUsd = (tokensIn * input + tokensOut * output) / 1_000_000;

  await db.insert(backtestResults).values({
    runId: run.id,
    caseKey: entry.key,
    rubricVersion: 1,
    timeline: timeline.map((step) => ({ at: step.at, score: step.score, grade: step.grade })),
    leadTimeHours,
    onTarget: targetResults.length ? targetResults.every((target) => target.met) : null,
    falseAlarms,
    masked: false,
  });
  await db.update(runs).set({ finishedAt: new Date(), success: true, counts: { steps, articles: bundle.length } }).where(eq(runs.id, run.id));

  return { key: entry.key, runId: run.id, articles: bundle.length, steps, timeline, firstReached, targetResults, leadTimeHours, missed, falseAlarms, costUsd };
}
