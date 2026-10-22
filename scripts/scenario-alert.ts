// 시나리오 생성·갱신과 텔레그램 알림 실행.
// 실행: npm run scenario                          ('경계' 이상 이슈의 시나리오 → 알림)
//       npm run scenario -- --ids=12,34          (시험용: 등급과 관계없이 지정 이슈의 시나리오를 만든다)
//       npm run scenario -- --ids=12 --preview   (시험용: 알림 문구만 미리 보기, 저장·발송 안 함)
// 텔레그램 키가 없으면 알림은 저장·발송 없이 미리 보기만 한다.

import { RULES } from "../lib/config/rules";
import { closeDb, getDb } from "../lib/db/client";
import { runAlerts } from "../lib/pipeline/alert";
import { buildScenarios } from "../lib/pipeline/scenario";
import { telegramReady } from "../lib/telegram";

function readArgs() {
  const args = process.argv.slice(2);
  const idsArg = args.find((arg) => arg.startsWith("--ids="))?.slice("--ids=".length);
  const issueIds = idsArg ? idsArg.split(",").map(Number) : undefined;
  if (issueIds?.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error(`--ids 값이 잘못되었습니다: ${idsArg}`);
  return { issueIds, preview: args.includes("--preview") };
}

async function main(): Promise<void> {
  const db = getDb();
  try {
    const { issueIds, preview } = readArgs();
    const { input, output } = RULES.ai.pricePerMillionTokens;
    const cost = (inputTokens: number, outputTokens: number) => {
      const usd = (inputTokens * input + outputTokens * output) / 1_000_000;
      return `약 $${usd.toFixed(4)} (약 ${Math.round(usd * 1400)}원)`;
    };

    const scenario = await buildScenarios(db, { issueIds, force: Boolean(issueIds) });
    console.log(`✅ 시나리오 — 새로 ${scenario.created}개, 갱신 ${scenario.updated}개, 변화 없어 건너뜀 ${scenario.skipped}개, 실패 ${scenario.failed}개 · ${cost(scenario.inputTokens, scenario.outputTokens)}`);

    const dryRun = preview || !telegramReady();
    if (dryRun && !preview) console.log("ℹ️  텔레그램 키가 없어 알림은 미리 보기만 합니다 (저장·발송 안 함)");
    const result = await runAlerts(db, { issueIds, dryRun, forceKind: preview && issueIds ? "신규" : undefined });
    console.log(`✅ 알림 — 발송 ${result.sent}건, 밤이라 보류 ${result.held}건, 폐기 ${result.discarded}건, 실패 ${result.failed}건 · ${cost(result.inputTokens, result.outputTokens)}`);
    for (const message of result.previewed) console.log(`\n──── 미리 보기 ────\n${message}`);
  } catch (error) {
    console.log(`❌ 실행 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
