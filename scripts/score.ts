// 점수화 실행: 진행 중인 이슈마다 영향도·가능성·속도와 종합 점수·등급을 매긴다.
// 실행: npm run score                (진행 중인 모든 이슈)
//       npm run score -- --ids=1,2,3 (지정한 이슈만)

import { RULES } from "../lib/config/rules";
import { closeDb, getDb } from "../lib/db/client";
import { scoreIssues } from "../lib/pipeline/score";

function readIds(): number[] | undefined {
  const arg = process.argv.find((value) => value.startsWith("--ids="))?.slice("--ids=".length);
  if (!arg) return undefined;
  const ids = arg.split(",").map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error(`--ids 값이 잘못되었습니다: ${arg}`);
  return ids;
}

async function main(): Promise<void> {
  const db = getDb();
  try {
    const startedAt = Date.now();
    const result = await scoreIssues(db, { issueIds: readIds() });
    const { input, output } = RULES.ai.pricePerMillionTokens;
    const costUsd = (result.inputTokens * input + result.outputTokens * output) / 1_000_000;
    const grades = Object.entries(result.gradeCounts).map(([grade, count]) => `${grade} ${count}`).join(" · ");

    console.log(`✅ 채점 ${result.scored}개 이슈 — AI 평가 ${result.evaluated}개, 직전 평가 재사용 ${result.reused}개, 평가 보류 ${result.failed}개`);
    console.log(`   등급: ${grades}`);
    console.log(`   토큰: 입력 ${result.inputTokens.toLocaleString()} / 출력 ${result.outputTokens.toLocaleString()} — 약 $${costUsd.toFixed(4)} (약 ${Math.round(costUsd * 1400)}원)`);
    console.log(`   걸린 시간: ${Math.round((Date.now() - startedAt) / 1000)}초`);
  } catch (error) {
    console.log(`❌ 점수화 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
