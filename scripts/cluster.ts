// 이슈 묶기 실행: 요약이 끝난 자료를 이슈 카드로 묶고, "(카더라)" 확인을 반영한다.
// 실행: npm run cluster                (한 번에 최대 RULES.issue.clusterMaxPerRun건)
//       npm run cluster -- --limit=100 (처리할 최대 건수 지정)

import { RULES } from "../lib/config/rules";
import { closeDb, getDb } from "../lib/db/client";
import { cluster, countUnclustered } from "../lib/pipeline/cluster";

function readLimit(): number {
  const arg = process.argv.find((value) => value.startsWith("--limit="))?.slice("--limit=".length);
  const limit = arg ? Number(arg) : RULES.issue.clusterMaxPerRun;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 값이 잘못되었습니다: ${arg}`);
  return limit;
}

async function main(): Promise<void> {
  const db = getDb();
  try {
    const limit = readLimit();
    console.log(`묶을 자료 ${await countUnclustered(db)}건 중 최대 ${limit}건 처리 시작\n`);

    const startedAt = Date.now();
    const result = await cluster(db, limit);
    const { input, output } = RULES.ai.pricePerMillionTokens;
    // 임베딩(text-embedding-3-small)은 100만 토큰당 0.02달러
    const costUsd = (result.inputTokens * input + result.outputTokens * output + result.embeddingTokens * 0.02) / 1_000_000;

    console.log(`\n✅ 판정 ${result.judged}건 — 리스크 관련 ${result.relevant}건 / 관련 없음 ${result.judged - result.relevant}건`);
    console.log(
      `   기존 이슈에 연결 ${result.linkedToExisting}건, 새 이슈 ${result.newIssues}개(그중 중복 합침 ${result.mergedIssues}개), 다시 연 보관 이슈 ${result.reopened}개, 카더라 확인 ${result.rumorsConfirmed}건, 뜻이 달라 거절한 연결 ${result.rejectedLinks}건, 실패 묶음 ${result.failedBatches}개`,
    );
    console.log(`   토큰: 입력 ${result.inputTokens.toLocaleString()} / 출력 ${result.outputTokens.toLocaleString()} — 약 $${costUsd.toFixed(4)} (약 ${Math.round(costUsd * 1400)}원)`);
    console.log(`   걸린 시간: ${Math.round((Date.now() - startedAt) / 1000)}초, 남은 자료 ${await countUnclustered(db)}건`);
    if (result.failedBatches > 0) process.exitCode = 1;
  } catch (error) {
    console.log(`❌ 이슈 묶기 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
