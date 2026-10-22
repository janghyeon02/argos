// 이슈 목록 (첫 화면).
// Design Ref: §4.2 — 맨 위 마지막 정상 수집 시각(2시간 넘게 멈추면 빨간 경고), 등급별 탭, 이슈 카드 목록.

import Link from "next/link";
import { Suspense } from "react";
import { GRADES, RULES, type Grade } from "@/lib/config/rules";
import { countByGrade, lastSuccessfulRun, listIssues } from "@/lib/data/issues";
import { requireSession } from "@/lib/session";
import { AxisBars, GRADE_BAR, GradeBadge, formatKst, timeAgo } from "./components/ui";

export default function HomePage({ searchParams }: PageProps<"/">) {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Suspense fallback={<ListSkeleton />}>
        <IssueBoard searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function IssueBoard({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  await requireSession();
  const requested = (await searchParams).grade;
  const grade = GRADES.find((value) => value === requested) as Grade | undefined;
  const [items, counts, lastRun] = await Promise.all([listIssues(grade), countByGrade(), lastSuccessfulRun()]);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const now = new Date();
  const stale = !lastRun || now.getTime() - lastRun.getTime() > RULES.collection.staleWarningHours * 3_600_000;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.2em] text-muted">GLOBAL RISK EARLY WARNING</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">아르고스</h1>
        </div>
        <div
          className={`rounded-lg px-3 py-2 text-xs ${
            stale ? "bg-[var(--grade-severe-bg)] font-semibold text-[var(--grade-severe)]" : "text-muted"
          }`}
        >
          {lastRun ? (
            <>
              마지막 정상 수집 {formatKst(lastRun)} ({timeAgo(lastRun, now)})
              {stale && " — 수집이 멈춘 것 같아요"}
            </>
          ) : (
            "아직 정상 수집 기록이 없어요"
          )}
        </div>
      </header>

      <nav className="mt-8 flex flex-wrap gap-2" aria-label="등급별 보기">
        <Tab href="/" active={!grade} label="전체" count={total} />
        {[...GRADES].reverse().map((value) => (
          <Tab key={value} href={`/?grade=${value}`} active={grade === value} label={value} count={counts[value]} />
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="mt-16 text-center text-sm text-muted">이 등급에 해당하는 이슈가 없어요.</p>
      ) : (
        <ul className="mt-6 grid gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/issues/${item.id}`}
                className="group relative block overflow-hidden rounded-xl border border-line bg-surface p-5 transition-shadow hover:shadow-md"
              >
                <span className={`absolute inset-y-0 left-0 w-1 ${GRADE_BAR[item.grade]}`} aria-hidden />
                <div className="flex flex-wrap items-center gap-2">
                  <GradeBadge grade={item.grade} score={item.score} />
                  {item.isBorderline && <span className="text-[11px] font-medium text-muted">경계선</span>}
                  <span className="ml-auto text-xs text-muted">
                    {item.lastArticleAt ? timeAgo(item.lastArticleAt, now) : ""}
                  </span>
                </div>
                <h2 className="mt-2 text-lg font-semibold leading-snug group-hover:text-accent">{item.title}</h2>
                {item.summaryKo && <p className="mt-1 line-clamp-2 text-sm text-muted">{item.summaryKo}</p>}
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="sm:w-80">
                    <AxisBars impact={item.impact} likelihood={item.likelihood} velocity={item.velocity} />
                  </div>
                  <p className="text-xs text-muted">
                    기사 {item.articleCount}건{item.recentCount > 0 && ` · 최근 24시간 ${item.recentCount}건`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Tab({ href, active, label, count }: { href: string; active: boolean; label: string; count: number }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
        active ? "border-ink bg-ink text-canvas" : "border-line bg-surface text-muted hover:text-ink"
      }`}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-10 w-40 rounded bg-line" />
      <div className="mt-8 flex gap-2">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-8 w-16 rounded-full bg-line" />
        ))}
      </div>
      <div className="mt-6 grid gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-36 rounded-xl bg-line" />
        ))}
      </div>
    </div>
  );
}
