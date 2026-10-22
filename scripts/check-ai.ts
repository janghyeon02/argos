// AI(OpenAI) 공용 모듈이 실제로 동작하는지 짧은 요청 한 번으로 확인한다.
// fast 모델로 한국어 요약 형식 답을 받아 본다. 비용은 아주 적다.
// 실행: npm run check:ai  (.env의 OPENAI_API_KEY 사용, 키 값은 출력하지 않음)

import OpenAI from "openai";
import { z } from "zod";
import { AiTaskError, askJson, MODELS } from "../lib/ai/llm";
import { RULES } from "../lib/config/rules";

const SummarySchema = z.object({
  summary_ko: z.string(),
  sentence_count: z.number().int(),
});

const SAMPLE =
  "The European Central Bank kept its key interest rates unchanged on Thursday, " +
  "saying inflation is on track to return to its 2% target, while warning that trade tensions remain a risk.";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.log("❌ OPENAI_API_KEY가 비어 있습니다. .env의 OPENAI_API_KEY= 뒤에 키를 넣고 다시 실행하세요.");
    process.exitCode = 1;
    return;
  }

  console.log(`AI 호출 확인 — 모델 ${MODELS.fast}`);
  const startedAt = Date.now();
  try {
    const result = await askJson({
      tier: "fast",
      maxTokens: 500,
      schemaName: "article_summary",
      system: "너는 국제 경제 기사를 한국어로 요약하는 도우미다. 원문에 없는 사실이나 수치를 만들지 않는다.",
      prompt: `아래 기사를 한국어 ${RULES.issue.summaryMaxSentences}문장 이내로 요약하고, 문장 수를 함께 적어라.\n\n${SAMPLE}`,
      schema: SummarySchema.refine(
        (value) => value.sentence_count >= 1 && value.sentence_count <= RULES.issue.summaryMaxSentences,
        { message: `문장 수는 1~${RULES.issue.summaryMaxSentences}이어야 합니다`, path: ["sentence_count"] },
      ),
    });
    console.log("✅ AI 호출 성공");
    console.log(`   답한 모델: ${result.model}`);
    console.log(`   시도 횟수: ${result.attempts}`);
    console.log(`   토큰: 입력 ${result.usage.inputTokens} / 출력 ${result.usage.outputTokens}`);
    console.log(`   걸린 시간: ${Date.now() - startedAt}ms`);
    console.log(`   요약(${result.data.sentence_count}문장): ${result.data.summary_ko}`);
  } catch (error) {
    console.log("❌ AI 호출 실패");
    if (error instanceof AiTaskError) {
      console.log(`   원인(${error.reason}): ${error.message}`);
    } else if (error instanceof OpenAI.AuthenticationError) {
      console.log("   원인: API 키가 올바르지 않습니다. .env의 OPENAI_API_KEY를 확인하세요.");
    } else if (error instanceof OpenAI.RateLimitError) {
      console.log("   원인: 요청 한도 또는 크레딧 부족입니다. OpenAI 결제·사용량 화면을 확인하세요.");
    } else if (error instanceof OpenAI.APIError) {
      console.log(`   원인: API 오류 ${error.status} — ${error.message}`);
    } else if (error instanceof Error) {
      console.log(`   원인: ${error.name} — ${error.message}`);
    } else {
      console.log(`   원인: ${String(error)}`);
    }
    process.exitCode = 1;
  }
}

void main();
