// 처리 범위: 실제(live) 데이터인지, 과거 검증(backtest) 실행의 데이터인지.
// Design Ref: §1 "실제와 검증은 절대 섞지 않는다", §7.5 — 같은 처리 코드를 기준 시각과 범위만 바꿔 과거에도 쓴다.

import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export type RunScope = { mode: "live" } | { mode: "backtest"; runId: number };

export const LIVE: RunScope = { mode: "live" };

/** 표의 mode·backtest_run_id 칸으로 범위를 거른다 */
export function inScope(table: { mode: PgColumn; backtestRunId: PgColumn }, scope: RunScope): SQL {
  return scope.mode === "live"
    ? eq(table.mode, "live")
    : (and(eq(table.mode, "backtest"), eq(table.backtestRunId, scope.runId)) as SQL);
}

/** 새로 넣는 행에 붙일 범위 값 */
export function scopeValues(scope: RunScope): { mode: "live" | "backtest"; backtestRunId: number | null } {
  return scope.mode === "live" ? { mode: "live", backtestRunId: null } : { mode: "backtest", backtestRunId: scope.runId };
}
