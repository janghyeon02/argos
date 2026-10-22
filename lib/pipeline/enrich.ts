// 2단계 요약·판정: 새 자료마다 한국어 요약, "(카더라)" 여부, 정정·철회 보도 여부를 정한다.
// Design Ref: §7.1 2단계 — AI: 한국어 3문장 요약, "(카더라)" 판정, 기존 자료의 정정·철회 보도인지 판정(맞으면 해당 자료 상태 변경).
// PRD Must① 규칙 3: 원문 언어와 상관없이 한국어 3문장 이내, 원문에 없는 수치·사실은 만들지 않는다.
// 원문 전문은 저장하지 않으므로 제목과 짧은 발췌만 보고 판단한다 (PRD 7번).

import { and, desc, eq, gte, isNull, lt, lte, ne } from "drizzle-orm";
import { z } from "zod";
import { askJson } from "../ai/llm";
import { RULES } from "../config/rules";
import { SOURCES } from "../config/sources";
import type { Db } from "../db/client";
import { articles } from "../db/schema";
import { inScope, LIVE, type RunScope } from "./scope";

// "(카더라)"로 볼 수 있는 대표 표현 (언어별). AI가 고른 근거 표현에 이 중 하나가 있어야 "(카더라)"로 인정한다.
const RUMOR_MARKERS =
  /소식통|관계자에 따르면|관계자는|알려졌다|전해졌다|전망설|설이 |루머|찌라시|reportedly|sources? (say|said|familiar)|according to (people|sources|a person)|people familiar|unnamed|rumou?r|speculat|insider|関係者によると|関係者への取材|とみられる|模様|laut (Insidern|Kreisen)|aus Kreisen|Gerüchte?|selon (des|nos) sources|rumeur|secondo (fonti|indiscrezioni)|indiscrezion|voci /i;

const TIER_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.tier]));
const NAME_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.name]));

// 지시문은 매번 같게 둔다 — 앞부분이 같으면 OpenAI가 자동으로 캐시해 비용이 줄어든다
const SYSTEM = `너는 국제 경제·금융 리스크를 감시하는 서비스의 기사 판정 도우미다.
여러 언어(한국어·영어·일본어·독일어·프랑스어·이탈리아어)의 기사 제목과 짧은 발췌를 받아, 기사마다 아래를 정한다.

1. summary_ko: 한국어 요약 1~${RULES.issue.summaryMaxSentences}문장.
   - 제목과 발췌에 있는 내용만 쓴다. 원문에 없는 수치·사실·배경 설명을 덧붙이지 않는다.
   - 수치·고유명사는 원문 그대로 옮긴다. excerpt가 비어 있거나 짧으면 제목의 뜻을 한국어 1문장으로 옮긴다.
   - 요약에는 기사 내용만 쓴다. 입력 자료의 상태(어떤 칸이 비었는지 등)에 대한 설명은 쓰지 않는다.
2. sentence_count: summary_ko의 문장 수.
3. is_rumor: 출처가 불분명하거나 공식 확인되지 않은 소문·전언이면 true.
   - true이면 rumor_evidence에 그렇게 판단한 표현을 제목이나 excerpt에서 글자 그대로 복사한다. false이면 빈 문자열.
   - true 예: "소식통에 따르면", "~로 알려졌다", "~설", "reportedly", "according to people familiar", "sources say", 익명 관계자 발언, SNS에 떠도는 주장.
   - false: 기관·기업의 공식 발표, 실명 인물의 발언, 확정된 지표·통계, 기자가 직접 확인한 사실.
   - false: 분석·해설·전망·칼럼·질문형 제목은 소문이 아니다. 제목과 발췌에 위와 같은 소문 표현이 실제로 없으면 false로 둔다.
4. correction: 이 기사가 다른 기사의 내용을 바로잡는 "정정" 보도이거나, 기사를 거둬들이는 "철회" 보도이면 그 종류, 아니면 "없음".
   - 일반적인 후속 보도·반박·입장 변화는 "없음"이다. 언론사 스스로 앞선 보도가 틀렸다고 밝힌 경우만 정정·철회로 본다.
5. correction_target: correction이 "없음"이 아니면, 바로잡히는 원래 기사를 찾을 수 있는 짧은 설명(한국어). 아니면 빈 문자열.

받은 기사 수만큼, 받은 id를 그대로 써서 답한다.`;

const ItemSchema = z.object({
  id: z.number().int(),
  summary_ko: z.string(),
  sentence_count: z.number().int(),
  is_rumor: z.boolean(),
  rumor_evidence: z.string(),
  correction: z.enum(["없음", "정정", "철회"]),
  correction_target: z.string(),
});

const BatchSchema = z.object({ items: z.array(ItemSchema) });

const TargetSchema = z.object({
  /** 바로잡히는 원래 기사 id, 찾지 못하면 0 */
  target_id: z.number().int(),
});

type ArticleRow = {
  id: number;
  sourceId: string;
  title: string;
  excerpt: string | null;
  language: string | null;
  publishedAt: Date;
};

export type EnrichResult = {
  processed: number;
  rumors: number;
  corrections: number;
  failedBatches: number;
  inputTokens: number;
  outputTokens: number;
};

function batchSchemaFor(ids: number[]) {
  const expected = new Set(ids);
  return BatchSchema.refine(
    (value) => value.items.length === ids.length && value.items.every((item) => expected.has(item.id)),
    { message: "받은 기사 id와 답의 id가 맞지 않습니다" },
  ).refine(
    (value) =>
      value.items.every(
        (item) =>
          item.summary_ko.trim().length > 0 &&
          item.sentence_count >= 1 &&
          item.sentence_count <= RULES.issue.summaryMaxSentences,
      ),
    { message: `요약은 1~${RULES.issue.summaryMaxSentences}문장이어야 합니다` },
  ).refine((value) => value.items.every((item) => !item.summary_ko.includes("발췌")), {
    message: "요약에 기사 내용이 아닌 입력 상태 설명이 들어 있습니다",
  });
}

function describe(row: ArticleRow) {
  return {
    id: row.id,
    source: NAME_BY_SOURCE.get(row.sourceId) ?? row.sourceId,
    tier: TIER_BY_SOURCE.get(row.sourceId) ?? 3,
    language: row.language,
    published_at: row.publishedAt.toISOString(),
    title: row.title,
    excerpt: row.excerpt ?? "",
  };
}

/** 정정·철회 보도가 바로잡는 원래 기사를 같은 출처의 최근 기사에서 찾는다 */
async function findCorrectionTarget(db: Db, row: ArticleRow, hint: string, scope: RunScope): Promise<{ id: number; tokens: [number, number] } | null> {
  const since = new Date(row.publishedAt.getTime() - RULES.enrich.correctionLookbackDays * 86_400_000);
  const candidates = await db
    .select({ id: articles.id, title: articles.title, publishedAt: articles.publishedAt })
    .from(articles)
    .where(
      and(
        eq(articles.sourceId, row.sourceId),
        inScope(articles, scope),
        ne(articles.id, row.id),
        gte(articles.publishedAt, since),
        lt(articles.publishedAt, row.publishedAt),
      ),
    )
    .orderBy(desc(articles.publishedAt))
    .limit(RULES.enrich.correctionCandidates);
  if (candidates.length === 0) return null;

  const result = await askJson({
    tier: "fast",
    schemaName: "correction_target",
    maxTokens: 200,
    system: "정정·철회 보도가 바로잡는 원래 기사를 후보 목록에서 고른다. 확실하지 않으면 0을 답한다.",
    prompt: JSON.stringify({
      correction_article: { title: row.title, excerpt: row.excerpt ?? "", hint },
      candidates: candidates.map((candidate) => ({ id: candidate.id, title: candidate.title })),
    }),
    schema: TargetSchema,
  });
  const found = candidates.find((candidate) => candidate.id === result.data.target_id);
  return found ? { id: found.id, tokens: [result.usage.inputTokens, result.usage.outputTokens] } : null;
}

/** 묶음 하나를 AI에 보내 판정하고 결과를 저장한다 */
async function enrichBatch(db: Db, rows: ArticleRow[], totals: EnrichResult, scope: RunScope): Promise<void> {
  const result = await askJson({
    tier: "fast",
    schemaName: "article_judgements",
    maxTokens: 300 * rows.length,
    system: SYSTEM,
    prompt: JSON.stringify({ articles: rows.map(describe) }),
    schema: batchSchemaFor(rows.map((row) => row.id)),
  });
  totals.inputTokens += result.usage.inputTokens;
  totals.outputTokens += result.usage.outputTokens;

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const item of result.data.items) {
    const row = byId.get(item.id)!;
    // "(카더라)" 판단은 근거 표현이 실제로 원문에 있을 때만 인정한다 (AI의 짐작을 막기 위해)
    // 1등급(공식 발표)은 출처 자체가 확인된 발표이므로 "(카더라)"로 보지 않는다
    const evidence = item.rumor_evidence.trim();
    const grounded = evidence.length > 0 && `${row.title} ${row.excerpt ?? ""}`.includes(evidence) && RUMOR_MARKERS.test(evidence);
    const isRumor = item.is_rumor && grounded && TIER_BY_SOURCE.get(row.sourceId) !== 1;
    await db.update(articles).set({ summaryKo: item.summary_ko.trim(), isRumor }).where(eq(articles.id, item.id));
    totals.processed++;
    if (isRumor) totals.rumors++;

    if (item.correction !== "없음") {
      const target = await findCorrectionTarget(db, row, item.correction_target, scope);
      if (target) {
        totals.inputTokens += target.tokens[0];
        totals.outputTokens += target.tokens[1];
        await db.update(articles).set({ status: item.correction, correctedBy: item.id }).where(eq(articles.id, target.id));
        totals.corrections++;
      }
    }
  }
}

/**
 * 아직 요약이 없는 실제 자료를 최신순으로 판정한다.
 * 묶음 하나가 실패해도 나머지는 계속하고, 실패한 자료는 다음 실행 때 다시 처리된다.
 */
export async function enrich(
  db: Db,
  limit: number = RULES.enrich.maxPerRun,
  options: { scope?: RunScope; until?: Date } = {},
): Promise<EnrichResult> {
  const scope = options.scope ?? LIVE;
  const pending: ArticleRow[] = await db
    .select({
      id: articles.id,
      sourceId: articles.sourceId,
      title: articles.title,
      excerpt: articles.excerpt,
      language: articles.language,
      publishedAt: articles.publishedAt,
    })
    .from(articles)
    .where(and(isNull(articles.summaryKo), inScope(articles, scope), options.until ? lte(articles.publishedAt, options.until) : undefined))
    .orderBy(desc(articles.publishedAt))
    .limit(limit);

  const totals: EnrichResult = { processed: 0, rumors: 0, corrections: 0, failedBatches: 0, inputTokens: 0, outputTokens: 0 };
  const batches: ArticleRow[][] = [];
  for (let i = 0; i < pending.length; i += RULES.enrich.batchSize) batches.push(pending.slice(i, i + RULES.enrich.batchSize));

  // 정해진 수만큼만 동시에 보낸다
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        await enrichBatch(db, batch, totals, scope);
      } catch (error) {
        // 묶음 안의 자료 하나 때문에 전체가 실패할 수 있으므로, 여러 건이면 한 건씩 나눠 다시 시도한다
        if (batch.length > 1) {
          batches.push(...batch.map((row) => [row]));
          continue;
        }
        totals.failedBatches++;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  ⚠️  묶음 실패 (자료 ${batch.map((row) => row.id).join(", ")}): ${message.slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RULES.enrich.concurrency, batches.length) }, worker));
  return totals;
}

/** 아직 요약이 없는 실제 자료 수 */
export function countPending(db: Db, scope: RunScope = LIVE): Promise<number> {
  return db.$count(articles, and(isNull(articles.summaryKo), inScope(articles, scope)));
}
