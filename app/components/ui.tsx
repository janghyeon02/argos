// 화면 공용 조각: 등급 배지, 세 축 막대, 시각 표시.

import type { Grade } from "@/lib/config/rules";

const GRADE_STYLE: Record<Grade, string> = {
  관심: "text-[var(--grade-watch)] bg-[var(--grade-watch-bg)]",
  주의: "text-[var(--grade-caution)] bg-[var(--grade-caution-bg)]",
  경계: "text-[var(--grade-warning)] bg-[var(--grade-warning-bg)]",
  심각: "text-[var(--grade-severe)] bg-[var(--grade-severe-bg)]",
};

export const GRADE_BAR: Record<Grade, string> = {
  관심: "bg-[var(--grade-watch)]",
  주의: "bg-[var(--grade-caution)]",
  경계: "bg-[var(--grade-warning)]",
  심각: "bg-[var(--grade-severe)]",
};

export function GradeBadge({ grade, score, large = false }: { grade: Grade; score?: number; large?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md font-semibold tabular-nums ${GRADE_STYLE[grade]} ${
        large ? "px-3 py-1.5 text-base" : "px-2 py-0.5 text-xs"
      }`}
    >
      {grade}
      {score !== undefined && <span className="opacity-80">{Math.round(score)}</span>}
    </span>
  );
}

/** 세 축(영향도·가능성·속도) 미니 막대 */
export function AxisBars({ impact, likelihood, velocity }: { impact: number | null; likelihood: number | null; velocity: number | null }) {
  const items = [
    { label: "영향", value: impact },
    { label: "가능성", value: likelihood },
    { label: "속도", value: velocity },
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <div className="flex items-baseline justify-between text-[11px] text-muted">
            <span>{item.label}</span>
            <span className="tabular-nums">{item.value === null ? "–" : Math.round(item.value)}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-ink/60" style={{ width: `${Math.min(100, item.value ?? 0)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 한국 시간 "10. 22. 14:07" */
export function formatKst(date: Date): string {
  return KST.format(date);
}

/** "3시간 전" 같은 상대 시각 */
export function timeAgo(date: Date, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

export const TIER_LABEL: Record<number, string> = { 1: "공식", 2: "주요 언론", 3: "기타" };
