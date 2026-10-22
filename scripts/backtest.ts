// 과거 사례 검증 실행.
// 실행: npm run backtest                          (자료 묶음이 있는 모든 사례 + 평온 기간)
//       npm run backtest -- --case=svb-2023      (사례 하나)
//       npm run backtest -- --step=6             (기준 시각을 6시간씩 옮김, 기본 3시간)
// 먼저 npm run backtest:fetch 로 자료 묶음을 만든다.

import { existsSync } from "node:fs";
import { closeDb, getDb } from "../lib/db/client";
import { loadCases, runCase } from "../lib/pipeline/backtest";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
  const stepHours = Number(args.find((arg) => arg.startsWith("--step="))?.slice("--step=".length) ?? 3);
  const { cases, calm } = loadCases();
  const all = [...cases, calm].filter((entry) => existsSync(`data/backtest/${entry.key}/articles.json`));
  const targets = only ? all.filter((entry) => entry.key === only) : all;
  if (targets.length === 0) throw new Error("검증할 자료 묶음이 없습니다. 먼저 npm run backtest:fetch 를 실행하세요.");

  const db = getDb();
  try {
    let totalCost = 0;
    for (const entry of targets) {
      console.log(`\n▶ ${entry.name} (${entry.key})`);
      const outcome = await runCase(db, entry, { stepHours, log: (line) => console.log(line) });
      totalCost += outcome.costUsd;
      console.log(`✅ ${entry.name} — 자료 ${outcome.articles}건, ${outcome.steps}단계`);
      for (const grade of ["주의", "경계", "심각"] as const) {
        if (outcome.firstReached[grade]) console.log(`   처음 '${grade}': ${outcome.firstReached[grade]}`);
      }
      for (const target of outcome.targetResults) {
        console.log(`   ${target.met ? "✅" : "❌"} ${target.label} — 목표 ${target.by}, 실제 ${target.reachedAt ?? "도달 못 함"}`);
      }
      if (outcome.leadTimeHours !== null) console.log(`   '경계' 선행 시간: ${outcome.leadTimeHours}시간 (음수면 T0 뒤)`);
      if (outcome.missed !== null) console.log(`   놓침: ${outcome.missed ? "예" : "아니오"}`);
      if (outcome.falseAlarms !== null) console.log(`   평온 기간 '경계' 이상 이슈: ${outcome.falseAlarms}개`);
      console.log(`   비용: 약 $${outcome.costUsd.toFixed(3)} (약 ${Math.round(outcome.costUsd * 1400)}원)`);
    }
    console.log(`\n전체 비용: 약 $${totalCost.toFixed(3)} (약 ${Math.round(totalCost * 1400)}원)`);
  } catch (error) {
    console.log(`❌ 검증 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
