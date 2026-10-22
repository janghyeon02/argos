// 과거 사례 검증 결과 표.
// Design Ref: §4.5 — 사례별 기준 시점·처음 '주의'·'경계' 시각·선행 시간·목표 달성 여부, 요약 표, 한계 문구. (점수 흐름 그래프는 Nice라 만들지 않음)

import Link from "next/link";
import { Suspense } from "react";
import { desc, eq } from "drizzle-orm";
import { GRADES, RULES, type Grade } from "@/lib/config/rules";
import { getDb } from "@/lib/db/client";
import { backtestResults, runs } from "@/lib/db/schema";
import { loadCases } from "@/lib/config/backtest-cases";
import { requireSession } from "@/lib/session";
import { GradeBadge, formatKst } from "../components/ui";

export default function BacktestPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link href="/" className="text-sm text-muted hover:text-ink">
        ← 이슈 목록
      </Link>
      <h1 className="mt-4 text-2xl font-bold tracking-tight">과거 사례 검증</h1>
      <p className="mt-1 text-sm text-muted">이 시스템이 그때 있었다면 언제 경보가 울렸을까 — 각 시점까지 공개된 기사만으로 다시 돌린 결과예요.</p>
      <Suspense fallback={<div className="mt-6 h-64 animate-pulse rounded-xl bg-line" />}>
        <Results />
      </Suspense>
    </main>
  );
}

async function Results() {
  await requireSession();
  const db = getDb();
  const { cases, calm } = loadCases();
  const rows = await db
    .select({ result: backtestResults, finishedAt: runs.finishedAt })
    .from(backtestResults)
    .innerJoin(runs, eq(runs.id, backtestResults.runId))
    .orderBy(desc(backtestResults.createdAt));
  // 사례마다 가장 최근 결과
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.result.caseKey)) latest.set(row.result.caseKey, row);

  const rank = (grade: string) => GRADES.indexOf(grade as Grade);
  const firstAt = (key: string, grade: Grade) => latest.get(key)?.result.timeline?.find((step) => rank(step.grade) >= rank(grade))?.at;
  const evaluated = cases.filter((entry) => latest.has(entry.key));
  const missed = evaluated.filter((entry) => {
    const warn = firstAt(entry.key, "경계");
    return !warn || new Date(warn).getTime() > new Date(entry.t0!).getTime() + RULES.validation.missWithinHoursAfterT0 * 3_600_000;
  }).length;
  const onTarget = evaluated.filter((entry) => latest.get(entry.key)?.result.onTarget).length;
  const calmRow = latest.get(calm.key);

  return (
    <div className="mt-6 grid gap-6">
      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="놓친 사례" value={`${missed} / ${evaluated.length}`} goal="목표 0" ok={evaluated.length > 0 && missed === 0} />
        <Stat
          label="목표 시간 달성"
          value={`${onTarget} / ${evaluated.length}`}
          goal={`목표 ${RULES.validation.minCasesOnTarget}개 이상`}
          ok={onTarget >= RULES.validation.minCasesOnTarget}
        />
        <Stat
          label="평온 기간 '경계' 이상"
          value={calmRow ? `${calmRow.result.falseAlarms ?? 0}개 이슈` : "–"}
          goal={`목표 주 ${RULES.validation.maxFalseAlarmsPerWeek}건 이하`}
          ok={calmRow ? (calmRow.result.falseAlarms ?? 0) <= RULES.validation.maxFalseAlarmsPerWeek : false}
        />
      </section>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">사례</th>
              <th className="px-4 py-3 font-medium">기준 시점(T0)</th>
              <th className="px-4 py-3 font-medium">처음 &lsquo;주의&rsquo;</th>
              <th className="px-4 py-3 font-medium">처음 &lsquo;경계&rsquo;</th>
              <th className="px-4 py-3 font-medium">선행 시간</th>
              <th className="px-4 py-3 font-medium">목표</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((entry) => {
              const row = latest.get(entry.key);
              const caution = firstAt(entry.key, "주의");
              const warning = firstAt(entry.key, "경계");
              const peak = row?.result.timeline?.reduce((best, step) => (step.score > best.score ? step : best), { score: 0, grade: "관심", at: "" });
              return (
                <tr key={entry.key} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium">{entry.name}</p>
                    <p className="text-xs text-muted">{entry.type}</p>
                    {peak && peak.score > 0 && (
                      <p className="mt-1 text-xs text-muted">
                        최고 <GradeBadge grade={peak.grade as Grade} score={peak.score} />
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {entry.t0Label}
                    <span className="block text-muted">{formatKst(new Date(entry.t0!))}</span>
                  </td>
                  <td className="px-4 py-3 text-xs">{row ? (caution ? formatKst(new Date(caution)) : "도달 못 함") : "–"}</td>
                  <td className="px-4 py-3 text-xs">{row ? (warning ? formatKst(new Date(warning)) : "도달 못 함") : "–"}</td>
                  <td className="px-4 py-3 text-xs tabular-nums">
                    {row?.result.leadTimeHours !== null && row?.result.leadTimeHours !== undefined
                      ? row.result.leadTimeHours >= 0
                        ? `T0 ${row.result.leadTimeHours}시간 전`
                        : `T0 ${Math.abs(row.result.leadTimeHours)}시간 뒤`
                      : "–"}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {row ? (
                      <ul className="grid gap-1">
                        {(entry.targets ?? []).map((target) => {
                          const reached = firstAt(entry.key, target.grade);
                          const met = reached !== undefined && new Date(reached) <= new Date(target.by);
                          return (
                            <li key={target.label}>
                              {met ? "✅" : "❌"} {target.label}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <span className="text-muted">아직 검증 전</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-line bg-surface p-6 text-sm leading-relaxed text-muted">
        <h2 className="mb-2 text-sm font-semibold text-ink">해석할 때 알아 둘 한계</h2>
        <ul className="list-disc pl-5">
          <li>과거 기사는 무료 뉴스 기록(GDELT)에서 우리 출처 언론사 기준으로 가져왔어요. 키워드로 고르지 않아 결과를 아는 상태의 선택은 피했지만, 국내 언론은 적게 잡혀요.</li>
          <li>
            분석 AI(gpt-4o-mini)는 2023년 10월까지의 자료로 학습했어요. 그 전 사례(2022 영국, 2023 SVB)는 AI가 결과를 이미 알고 있을 수 있어 점수가 실제보다 좋게 나올 수 있고, 그 뒤 사례(2024 계엄, 2025 상호관세)는 이 위험이 작아요.
          </li>
          <li>&lsquo;관련 이슈&rsquo;는 사례 설명과 뜻이 가까운 이슈로 찾아요. 이 사후 기준은 결과를 재는 데만 쓰고, 경보를 울리는 데는 쓰지 않아요.</li>
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value, goal, ok }: { label: string; value: string; goal: string; ok: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      <p className={`mt-1 text-xs ${ok ? "text-accent" : "text-muted"}`}>{goal}</p>
    </div>
  );
}
