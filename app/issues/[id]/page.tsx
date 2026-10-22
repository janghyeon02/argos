// 이슈 상세.
// Design Ref: §4.3 — 머리(등급·점수) → 지금 상황 → 시나리오('경계' 이상) → 점수 근거 → 타임라인 → 면책 문구.

import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { IMPACT_CHANNELS, RULES } from "@/lib/config/rules";
import { getIssue } from "@/lib/data/issues";
import { requireSession } from "@/lib/session";
import { AxisBars, GradeBadge, TIER_LABEL, formatKst, timeAgo } from "../../components/ui";

export default function IssuePage({ params }: PageProps<"/issues/[id]">) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/" className="text-sm text-muted hover:text-ink">
        ← 이슈 목록
      </Link>
      <Suspense fallback={<div className="mt-6 h-96 animate-pulse rounded-xl bg-line" />}>
        <IssueDetail params={params} />
      </Suspense>
    </main>
  );
}

async function IssueDetail({ params }: { params: PageProps<"/issues/[id]">["params"] }) {
  await requireSession();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const data = await getIssue(id);
  if (!data) notFound();
  const { issue, score, timeline } = data;
  const now = new Date();
  const evidenceIds = new Set([...(score?.evidence?.impact ?? []), ...(score?.evidence?.likelihood ?? [])]);
  const scenarioReady = RULES.grade.minScore[issue.grade] >= RULES.grade.minScore[RULES.scenario.minGrade];

  return (
    <article className="mt-6 grid gap-6">
      <header className="rounded-xl border border-line bg-surface p-6">
        <div className="flex flex-wrap items-center gap-2">
          <GradeBadge grade={issue.grade} score={issue.score} large />
          {issue.isBorderline && <span className="text-xs font-medium text-muted">경계선</span>}
          <span className="text-xs text-muted">· {issue.status}</span>
        </div>
        <h1 className="mt-3 text-2xl font-bold leading-snug tracking-tight">{issue.title}</h1>
        {issue.summaryKo && <p className="mt-3 leading-relaxed text-muted">{issue.summaryKo}</p>}
      </header>

      <Section title="시나리오">
        {scenarioReady ? (
          <p className="text-sm text-muted">시나리오 생성 기능은 다음 단계에서 붙어요.</p>
        ) : (
          <p className="text-sm text-muted">
            시나리오는 &lsquo;{RULES.scenario.minGrade}&rsquo; 이상 이슈에서 만들어져요. 지금은 &lsquo;{issue.grade}&rsquo; 단계예요.
          </p>
        )}
      </Section>

      <Section title="점수 근거">
        {score ? (
          <div className="grid gap-5">
            <AxisBars impact={score.impact} likelihood={score.likelihood} velocity={score.velocity} />
            <div>
              <p className="text-xs font-medium text-muted">영향 경로 (0~5, 5번 평가의 중앙값)</p>
              <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
                {IMPACT_CHANNELS.map((channel) => {
                  const value = score.channelScores?.median[channel] ?? 0;
                  return (
                    <li key={channel} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-muted">{channel}</span>
                      <span className="flex gap-0.5" aria-label={`${value}점`}>
                        {Array.from({ length: RULES.impact.channelMax }, (_, index) => (
                          <span key={index} className={`h-2 w-2 rounded-sm ${index < value ? "bg-ink/70" : "bg-line"}`} />
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <p className="text-xs text-muted">
              5번 평가의 종합 점수: {(score.compositeRuns ?? []).map((value) => Math.round(value)).join(" · ")} → 중앙값{" "}
              {Math.round(score.composite)}점 · 평가 기준표 v{score.rubricVersion} · {formatKst(score.createdAt)} 채점
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">아직 채점되지 않았어요.</p>
        )}
      </Section>

      <Section title={`타임라인 (${timeline.length}건)`}>
        <ol className="grid gap-4">
          {timeline.map((item) => (
            <li key={item.id} className="relative border-l-2 border-line pl-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <time dateTime={item.publishedAt.toISOString()}>{formatKst(item.publishedAt)}</time>
                <span>·</span>
                <span className="font-medium text-ink">{item.sourceName}</span>
                <span className="rounded border border-line px-1.5 py-px">
                  {item.tier}등급 {TIER_LABEL[item.tier]}
                </span>
                {item.region && <span>{item.region}</span>}
                {item.isRumor && <span className="rounded bg-[var(--grade-caution-bg)] px-1.5 py-px text-[var(--grade-caution)]">카더라</span>}
                {item.status !== "정상" && <span className="rounded bg-[var(--grade-severe-bg)] px-1.5 py-px text-[var(--grade-severe)]">{item.status}</span>}
                {evidenceIds.has(item.id) && <span className="text-accent">점수 근거</span>}
              </div>
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-1 block font-medium leading-snug hover:text-accent">
                {item.title}
              </a>
              {item.summaryKo && <p className="mt-1 text-sm leading-relaxed text-muted">{item.summaryKo}</p>}
              <p className="mt-1 text-[11px] text-muted">{timeAgo(item.publishedAt, now)}</p>
            </li>
          ))}
        </ol>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-6">
      <h2 className="mb-4 text-sm font-semibold tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}
