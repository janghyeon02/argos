// Claude API 공용 호출 모듈.
// Design Ref: §3.1 — 요약·묶기·점수는 Sonnet, 시나리오·기준표 보완은 Opus.
// Design Ref: §1 "AI 답변은 검사 후 사용" — 정해진 형식(Zod)을 지키지 않은 답은 버리고 다시 묻는다.
// Design Ref: §10 — 형식 오류는 최대 RULES.ai.maxRetries번 다시 시도하고, 그래도 실패하면 오류를 던져 호출한 쪽이 "평가 보류"로 처리한다.
// 서버 쪽(처리 스크립트)에서만 쓴다. API 키는 ANTHROPIC_API_KEY 환경변수에서 SDK가 읽는다.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { RULES } from "../config/rules";

/** 용도별 모델 — fast: 요약·묶기·점수(반복 호출이 많음), deep: 시나리오·기준표 보완(깊은 판단) */
export const MODELS = {
  fast: "claude-sonnet-5-5",
  deep: "claude-opus-5-5",
} as const;
export type ModelTier = keyof typeof MODELS;

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** 용도별 기본 생각 깊이 — Opus 5.5의 기본값은 medium이라 명시한다 */
const DEFAULT_EFFORT: Record<ModelTier, Effort> = { fast: "medium", deep: "high" };

/** 거절 시 서버가 알아서 다른 모델로 이어 받게 하는 기능 (Claude API 전용) */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type AskJsonOptions<S extends z.ZodType> = {
  tier: ModelTier;
  /** 역할·규칙 설명 (매번 같은 내용이면 캐시되어 비용이 줄어든다) */
  system: string;
  /** 이번 요청 내용 */
  prompt: string;
  /** 답변 형식 — 이 형식에 맞지 않으면 다시 묻는다 */
  schema: S;
  effort?: Effort;
  maxTokens?: number;
};

export type AskJsonResult<T> = {
  data: T;
  /** 실제로 답한 모델 (거절 시 다른 모델이 이어 받았을 수 있음) */
  model: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
};

/** 다시 시도해도 형식에 맞는 답을 받지 못했거나, 모델이 요청을 거절한 경우 */
export class ClaudeTaskError extends Error {
  constructor(
    message: string,
    readonly reason: "refusal" | "format" | "max_tokens",
    readonly attempts: number,
  ) {
    super(message);
    this.name = "ClaudeTaskError";
  }
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  // 네트워크 오류·429·5xx는 SDK가 기본 2번 다시 시도한다
  client ??= new Anthropic();
  return client;
}

/**
 * Claude에 질문하고, schema 형식에 맞는 JSON 답을 돌려준다.
 * - 형식 오류·출력 잘림은 최대 RULES.ai.maxRetries번 다시 묻는다.
 * - 거절(refusal)은 다시 묻지 않고 ClaudeTaskError를 던진다.
 * - 인증·요청 오류(Anthropic.APIError)는 그대로 던진다.
 */
export async function askJson<S extends z.ZodType>(options: AskJsonOptions<S>): Promise<AskJsonResult<z.infer<S>>> {
  const { tier, system, prompt, schema, effort = DEFAULT_EFFORT[tier], maxTokens = 16000 } = options;
  const maxAttempts = 1 + RULES.ai.maxRetries;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let lastProblem = "";
  let lastReason: ClaudeTaskError["reason"] = "format";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await getClient().beta.messages.parse({
        model: MODELS[tier],
        max_tokens: maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort, format: betaZodOutputFormat(schema) },
      });
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw error;
      // SDK가 답을 형식에 맞춰 읽지 못한 경우 — 다시 묻는다
      lastReason = "format";
      lastProblem = error instanceof Error ? error.message : String(error);
      continue;
    }

    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "알 수 없음";
      throw new ClaudeTaskError(`모델이 요청을 거절했습니다 (분류: ${category})`, "refusal", attempt);
    }
    if (response.stop_reason === "max_tokens") {
      lastReason = "max_tokens";
      lastProblem = `답이 ${maxTokens} 토큰에서 잘렸습니다`;
      continue;
    }

    // SDK의 해석 결과를 우리 schema로 한 번 더 검사한다 (refine 같은 추가 규칙까지 확인)
    const checked = schema.safeParse(response.parsed_output);
    if (checked.success) {
      return { data: checked.data, model: response.model, attempts: attempt, usage };
    }
    lastReason = "format";
    lastProblem = checked.error.issues.map((issue) => `${issue.path.join(".") || "(전체)"}: ${issue.message}`).join("; ");
  }

  throw new ClaudeTaskError(`형식에 맞는 답을 받지 못했습니다 — ${lastProblem}`, lastReason, maxAttempts);
}
