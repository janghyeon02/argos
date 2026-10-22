// 요약·판정 실행: 요약이 없는 자료에 한국어 요약, "(카더라)" 여부, 정정·철회 여부를 매긴다.
// 실행: npm run enrich                (한 번에 최대 RULES.enrich.maxPerRun건)
//       npm run enrich -- --limit=20  (처리할 최대 건수 지정)

import { closeDb, getDb } from "../lib/db/client";
import { RULES } from "../lib/config/rules";
import { countPending, enrich } from "../lib/pipeline/enrich";

function readLimit(): number {
  const arg = process.argv.find((value) => value.startsWith("--limit="))?.slice("--limit=".length);
  const limit = arg ? Number(arg) : RULES.enrich.maxPerRun;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 값이 잘못되었습니다: ${arg}`);
  return limit;
}

async function main(): Promise<void> {
  const db = getDb();
  try {
    const limit = readLimit();
    const before = await countPending(db);
    console.log(`요약이 필요한 자료 ${before}건 중 최대 ${limit}건 처리 시작\n`);

    const startedAt = Date.now();
    const result = await enrich(db, limit);
    const { input, output } = RULES.ai.pricePerMillionTokens;
    const costUsd = (result.inputTokens * input + result.outputTokens * output) / 1_000_000;

    console.log(`\n✅ 처리 ${result.processed}건 — "(카더라)" ${result.rumors}건, 정정·철회 연결 ${result.corrections}건, 실패 묶음 ${result.failedBatches}개`);
    console.log(`   토큰: 입력 ${result.inputTokens.toLocaleString()} / 출력 ${result.outputTokens.toLocaleString()} — 약 $${costUsd.toFixed(4)} (약 ${Math.round(costUsd * 1400)}원)`);
    console.log(`   걸린 시간: ${Math.round((Date.now() - startedAt) / 1000)}초, 남은 자료 ${await countPending(db)}건`);
    if (result.failedBatches > 0) process.exitCode = 1;
  } catch (error) {
    console.log(`❌ 요약·판정 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
