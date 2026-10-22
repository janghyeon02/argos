// 과거 검증 사례 정의 (data/backtest/cases.json). 화면과 검증 스크립트가 함께 쓴다.
// JSON을 직접 불러와 배포(Vercel)에도 함께 묶이게 한다.

import raw from "../../data/backtest/cases.json";
import type { Grade } from "./rules";

export type CaseTarget = { grade: Grade; by: string; label: string };
export type BacktestCase = {
  key: string;
  name: string;
  type?: string;
  description?: string;
  t0?: string;
  t0Label?: string;
  window: { start: string; end: string };
  targets?: CaseTarget[];
};

export function loadCases(): { cases: BacktestCase[]; calm: BacktestCase } {
  return raw as unknown as { cases: BacktestCase[]; calm: BacktestCase };
}
