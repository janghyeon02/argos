// AI(OpenAI) 공용 호출 모듈.
// 사용자 결정: Claude API 대신 OpenAI를 쓰고, 비용이 적은 gpt-4o-mini를 기본으로 한다.
// Design Ref: §1 "AI 답변은 검사 후 사용" — 정해진 형식(Zod)을 지키지 않은 답은 버리고 다시 묻는다.
// Design Ref: §10 — 형식 오류는 최대 RULES.ai.maxRetries번 다시 시도하고, 그래도 실패하면 오류를 던져 호출한 쪽이 "평가 보류"로 처리한다.
// 서버 쪽(처리 스크립트)에서만 쓴다. API 키는 OPENAI_API_KEY 환경변수에서 SDK가 읽는다.

import OpenAI from "openai";
import { ContentFilterFinishReasonError, LengthFinishReasonError } from "openai/core/error";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { RULES } from "../config/rules";

/** 용도별 모델 — fast: 요약·묶기·점수, deep: 시나리오·기준표 보완. 지금은 비용을 위해 둘 다 gpt-4o-mini */
export const MODELS = {
  fast: "gpt-4o-mini",
  deep: "gpt-4o-mini",
} as const;
export type ModelTier = keyof typeof MODELS;

export type AskJsonOptions<S extends z.ZodType> = {
  tier: ModelTier;
  /** 역할·규칙 설명 (매번 같은 내용을 앞에 두면 OpenAI가 자동으로 캐시해 비용이 줄어든다) */
  system: string;
  /** 이번 요청 내용 */
  prompt: string;
  /** 답변 형식 — 이 형식에 맞지 않으면 다시 묻는다 */
  schema: S;
  /** 답변 형식 이름 (영문·숫자·밑줄) */
  schemaName?: string;
  maxTokens?: number;
};

export type AskJsonResult<T> = {
  data: T;
  /** 실제로 답한 모델 */
  model: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
};

/** 다시 시도해도 형식에 맞는 답을 받지 못했거나, 모델이 요청을 거절한 경우 */
export class AiTaskError extends Error {
  constructor(
    message: string,
    readonly reason: "refusal" | "format" | "max_tokens",
    readonly attempts: number,
  ) {
    super(message);
    this.name = "AiTaskError";
  }
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  // 네트워크 오류·429·5xx는 SDK가 기본 2번 다시 시도한다
  client ??= new OpenAI();
  return client;
}

/**
 * AI에 질문하고, schema 형식에 맞는 JSON 답을 돌려준다.
 * - 형식 오류·출력 잘림은 최대 RULES.ai.maxRetries번 다시 묻는다.
 * - 거절은 다시 묻지 않고 AiTaskError를 던진다.
 * - 인증·요청 오류(OpenAI.APIError)는 그대로 던진다.
 */
export async function askJson<S extends z.ZodType>(options: AskJsonOptions<S>): Promise<AskJsonResult<z.infer<S>>> {
  const { tier, system, prompt, schema, schemaName = "answer", maxTokens = 4000 } = options;
  const maxAttempts = 1 + RULES.ai.maxRetries;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let lastProblem = "";
  let lastReason: AiTaskError["reason"] = "format";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let completion;
    try {
      completion = await getClient().chat.completions.parse({
        model: MODELS[tier],
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        response_format: zodResponseFormat(schema, schemaName),
      });
    } catch (error) {
      if (error instanceof LengthFinishReasonError) {
        lastReason = "max_tokens";
        lastProblem = `답이 ${maxTokens} 토큰에서 잘렸습니다`;
        continue;
      }
      if (error instanceof ContentFilterFinishReasonError) {
        throw new AiTaskError("콘텐츠 필터에 걸려 답을 받지 못했습니다", "refusal", attempt);
      }
      if (error instanceof OpenAI.APIError) throw error;
      // SDK가 답을 형식에 맞춰 읽지 못한 경우 — 다시 묻는다
      lastReason = "format";
      lastProblem = error instanceof Error ? error.message : String(error);
      continue;
    }

    usage.inputTokens += completion.usage?.prompt_tokens ?? 0;
    usage.outputTokens += completion.usage?.completion_tokens ?? 0;

    const message = completion.choices[0]?.message;
    if (message?.refusal) {
      throw new AiTaskError(`모델이 요청을 거절했습니다: ${message.refusal}`, "refusal", attempt);
    }

    // SDK의 해석 결과를 우리 schema로 한 번 더 검사한다 (refine 같은 추가 규칙까지 확인)
    const checked = schema.safeParse(message?.parsed);
    if (checked.success) {
      return { data: checked.data, model: completion.model, attempts: attempt, usage };
    }
    lastReason = "format";
    lastProblem = checked.error.issues.map((issue) => `${issue.path.join(".") || "(전체)"}: ${issue.message}`).join("; ");
  }

  throw new AiTaskError(`형식에 맞는 답을 받지 못했습니다 — ${lastProblem}`, lastReason, maxAttempts);
}

/** 글 뜻 비교용 모델 — 이슈 묶기에서 AI 판단이 엉뚱하지 않은지 확인하는 데 쓴다 (비용이 아주 적다) */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/** 글마다 뜻을 나타내는 숫자 목록(임베딩)을 돌려준다. 순서는 입력과 같다. */
export async function embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  if (texts.length === 0) return { vectors: [], tokens: 0 };
  const response = await getClient().embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  return { vectors, tokens: response.usage.total_tokens };
}

/** 두 글의 뜻이 얼마나 가까운지 (-1~1, 클수록 비슷함) */
export function similarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / Math.sqrt(normA * normB);
}

/**
 * 같은 질문에 대한 답을 count개 받는다 (점수 5번 평가용).
 * 한 번의 요청으로 여러 답을 받아 입력 비용은 한 번만 낸다. 형식에 맞지 않는 답은 빼고, 모자라면 모자란 수만큼 다시 묻는다.
 */
export async function askJsonSamples<S extends z.ZodType>(
  options: AskJsonOptions<S>,
  count: number,
): Promise<{ data: z.infer<S>[]; usage: { inputTokens: number; outputTokens: number } }> {
  const { tier, system, prompt, schema, schemaName = "answer", maxTokens = 4000 } = options;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const data: z.infer<S>[] = [];
  let lastProblem = "";

  for (let attempt = 1; attempt <= 1 + RULES.ai.maxRetries && data.length < count; attempt++) {
    let completion;
    try {
      completion = await getClient().chat.completions.parse({
        model: MODELS[tier],
        max_completion_tokens: maxTokens,
        n: count - data.length,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        response_format: zodResponseFormat(schema, schemaName),
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError) throw error;
      lastProblem = error instanceof Error ? error.message : String(error);
      continue;
    }
    usage.inputTokens += completion.usage?.prompt_tokens ?? 0;
    usage.outputTokens += completion.usage?.completion_tokens ?? 0;
    for (const choice of completion.choices) {
      if (choice.message.refusal) throw new AiTaskError(`모델이 요청을 거절했습니다: ${choice.message.refusal}`, "refusal", attempt);
      const checked = schema.safeParse(choice.message.parsed);
      if (checked.success) data.push(checked.data);
      else lastProblem = checked.error.issues.map((issue) => `${issue.path.join(".") || "(전체)"}: ${issue.message}`).join("; ");
    }
  }

  if (data.length < count) {
    throw new AiTaskError(`형식에 맞는 답을 ${count}개 받지 못했습니다 (${data.length}개) — ${lastProblem}`, "format", 1 + RULES.ai.maxRetries);
  }
  return { data, usage };
}
