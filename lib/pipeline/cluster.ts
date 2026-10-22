// 3단계 묶기 + 4단계 카더라 확인: 요약이 끝난 자료를 이슈 카드로 묶는다.
// Design Ref: §7.1 3단계 — 같은 이슈인지 확신도로 판단(0.7 기준), 보관된 이슈에 묶이면 '진행 중'으로 다시 열기.
// Design Ref: §7.1 4단계 — 이슈에 새로 들어온 1·2등급 자료가 같은 이슈의 "(카더라)" 자료를 확인해 주면 정식 근거로 바꾼다.
// PRD Must① 규칙 2: 확신도 0.7 미만이면 새 카드를 만들고, 자료 1건은 카드 1개에만 넣는다.
// 경제·금융·지정학 리스크와 관련 없는 자료(지역 사건·스포츠·문화 등)는 이슈로 묶지 않는다.

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { askJson, embed, similarity } from "../ai/llm";
import { RULES } from "../config/rules";
import { SOURCES } from "../config/sources";
import type { Db } from "../db/client";
import { articles, issueArticles, issues } from "../db/schema";
import { inScope, LIVE, scopeValues, type RunScope } from "./scope";

const TIER_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.tier]));
const NAME_BY_SOURCE = new Map(SOURCES.map((source) => [source.id, source.name]));

// 지시문은 매번 같게 둔다 — 앞부분이 같으면 OpenAI가 자동으로 캐시해 비용이 줄어든다
const SYSTEM = `너는 한국 경제에 영향을 줄 수 있는 국내외 리스크를 감시하는 서비스에서, 새 기사를 "이슈"로 묶는 도우미다.
이슈는 시간이 지나며 계속 이어지는 하나의 사건·흐름이다 (예: "프랑스 예산 갈등", "미국 상호관세 확대", "중동 분쟁과 유가").

기사마다 아래를 정한다.
1. relevant: 한국 경제·금융시장, 세계 금융시장, 통상·공급망·에너지, 국내외 정치·안보 위기 중 하나에 영향을 줄 수 있는 기사면 true.
   - false 예: 지역 사건·사고, 범죄, 날씨, 스포츠, 연예·문화·행사, 생활 정보, 개별 기업의 소소한 홍보·제품 출시.
2. relevant가 true이면 이슈를 정한다.
   - 기존 이슈 목록 중 같은 사건·흐름이면 issue_id에 그 id를 넣고, 같은 이슈라고 보는 확신도(0~1)를 confidence에 넣는다.
   - 맞는 기존 이슈가 없으면 issue_id는 0으로 두고, new_issue_key에 이번 묶음 안에서만 쓰는 짧은 영문 키(예: "france-budget")를 정한다.
     같은 묶음의 다른 기사도 같은 새 이슈면 같은 키를 쓴다.
   - new_issue_title(한국어 15자 안팎, 사건·흐름이 드러나게)과 new_issue_summary(한국어 1~2문장)는 관련 기사면 항상 쓴다.
     기존 이슈에 연결하더라도, 이 기사로 새 이슈를 만든다면 붙일 제목·요약을 쓴다.
     같은 키를 쓰는 기사들은 제목·요약을 같게 쓴다.
3. relevant가 false이면 issue_id 0, confidence 0, 나머지는 빈 문자열로 둔다.

같은 이슈로 묶는 기준:
   - 같은 사건·흐름이어야 한다. 행위 주체(나라·기관·기업)와 쟁점이 같아야 하며, 같은 나라 이야기라는 것만으로는 묶지 않는다.
   - 예: "북한 지뢰 도발"과 "미중 무역 전쟁"은 둘 다 안보·통상 이슈지만 서로 다른 이슈다.
   - 기존 이슈에 연결할 때는 match_reason에 공통된 주체와 쟁점을 한 문장으로 쓴다. 공통점을 구체적으로 쓸 수 없으면 새 이슈로 만든다.
   - 이슈 제목과 요약은 반드시 한국어로 쓴다.
이슈는 너무 넓게(예: "세계 경제", "글로벌 금융 위기") 묶지도, 너무 좁게(기사 한 건마다 새 이슈) 나누지도 않는다.
받은 기사 수만큼, 받은 id를 그대로 써서 답한다.`;

const ItemSchema = z.object({
  id: z.number().int(),
  relevant: z.boolean(),
  issue_id: z.number().int(),
  confidence: z.number(),
  match_reason: z.string(),
  new_issue_key: z.string(),
  new_issue_title: z.string(),
  new_issue_summary: z.string(),
});

const BatchSchema = z.object({ items: z.array(ItemSchema) });

const RumorCheckSchema = z.object({
  items: z.array(z.object({ rumor_id: z.number().int(), confirmed_by: z.number().int() })),
});

type PendingArticle = {
  id: number;
  sourceId: string;
  title: string;
  summaryKo: string | null;
  isRumor: boolean;
  publishedAt: Date;
};

type CandidateIssue = { id: number; title: string; summaryKo: string | null; status: string };

export type ClusterResult = {
  judged: number;
  relevant: number;
  linkedToExisting: number;
  newIssues: number;
  reopened: number;
  rumorsConfirmed: number;
  failedBatches: number;
  /** 같은 사건이라 합친 이슈 수 */
  mergedIssues: number;
  /** AI가 연결했지만 글 뜻이 달라 받아들이지 않은 수 */
  rejectedLinks: number;
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
};

/** 묶기 비교 대상: 진행 중 이슈 + 최근 90일 안에 보관된 이슈, 최근에 자료가 들어온 순 */
async function loadCandidateIssues(db: Db, now: Date, scope: RunScope): Promise<CandidateIssue[]> {
  const since = new Date(now.getTime() - RULES.issue.reopenArchivedWithinDays * 86_400_000);
  return db
    .select({ id: issues.id, title: issues.title, summaryKo: issues.summaryKo, status: issues.status })
    .from(issues)
    .where(and(inScope(issues, scope), or(eq(issues.status, "진행 중"), gte(issues.archivedAt, since))))
    .orderBy(desc(sql`coalesce(${issues.lastArticleAt}, ${issues.createdAt})`))
    .limit(RULES.issue.maxCandidateIssues);
}

function batchSchemaFor(ids: number[]) {
  const expected = new Set(ids);
  return BatchSchema.refine(
    (value) => value.items.length === ids.length && value.items.every((item) => expected.has(item.id)),
    { message: "받은 기사 id와 답의 id가 맞지 않습니다" },
  ).refine(
    (value) =>
      value.items.every(
        (item) =>
          !item.relevant || item.issue_id > 0 || item.new_issue_key.trim() !== "",
      ),
    { message: "관련 기사는 기존 이슈 id 또는 새 이슈 키·제목이 있어야 합니다" },
  ).refine(
    (value) => value.items.every((item) => !item.relevant || item.issue_id > 0 || /[가-힣]/.test(item.new_issue_title)),
    { message: "새 이슈 제목은 한국어여야 합니다" },
  );
}

/** 아직 뜻(임베딩)을 모르는 이슈만 한 번에 계산해 캐시에 넣는다 */
async function ensureVectors(pool: CandidateIssue[], cache: Map<number, number[]>, totals: ClusterResult): Promise<void> {
  const missing = pool.filter((issue) => !cache.has(issue.id));
  if (missing.length === 0) return;
  const embedded = await embed(missing.map((issue) => `${issue.title}\n${issue.summaryKo ?? ""}`));
  totals.embeddingTokens += embedded.tokens;
  missing.forEach((issue, index) => cache.set(issue.id, embedded.vectors[index]));
}

/** 묶음 하나를 AI에 보내 이슈를 정하고 저장한다. 새로 생긴 이슈는 후보 목록에 바로 더한다. */
async function clusterBatch(
  db: Db,
  rows: PendingArticle[],
  candidates: CandidateIssue[],
  touched: Set<number>,
  totals: ClusterResult,
  now: Date,
  issueVectors: Map<number, number[]>,
  scope: RunScope,
): Promise<void> {
  // 기사마다 뜻이 가장 가까운 기존 이슈만 골라 보여 준다 (프롬프트를 작게 유지해 빠르고 정확하게).
  // 새 이슈는 공유 목록(candidates) 앞에 더해져 다음 묶음이 본다.
  const pool = candidates.slice(0, RULES.issue.maxCandidateIssues);
  await ensureVectors(pool, issueVectors, totals);
  const articleTexts = rows.map((row) => `${row.title}\n${row.summaryKo ?? ""}`);
  const embeddedArticles = await embed(articleTexts);
  totals.embeddingTokens += embeddedArticles.tokens;
  const articleVector = new Map(rows.map((row, index) => [row.id, embeddedArticles.vectors[index]]));
  const shownIds = new Set<number>();
  for (const row of rows) {
    const vector = articleVector.get(row.id)!;
    pool
      .map((issue) => ({ id: issue.id, score: similarity(vector, issueVectors.get(issue.id)!) }))
      .filter((item) => item.score >= RULES.issue.minCandidateSimilarity)
      .sort((a, b) => b.score - a.score)
      .slice(0, RULES.issue.candidatesPerArticle)
      .forEach((item) => shownIds.add(item.id));
  }
  const shown = pool.filter((issue) => shownIds.has(issue.id));
  const issueIds = new Set(shown.map((issue) => issue.id));
  const result = await askJson({
    tier: "fast",
    schemaName: "issue_clustering",
    maxTokens: 160 * rows.length + 200,
    system: SYSTEM,
    prompt: JSON.stringify({
      existing_issues: shown.map((issue) => ({ id: issue.id, title: issue.title, summary: issue.summaryKo ?? "" })),
      articles: rows.map((row) => ({
        id: row.id,
        source: NAME_BY_SOURCE.get(row.sourceId) ?? row.sourceId,
        published_at: row.publishedAt.toISOString(),
        title: row.title,
        summary: row.summaryKo ?? "",
      })),
    }),
    schema: batchSchemaFor(rows.map((row) => row.id)),
  });
  totals.inputTokens += result.usage.inputTokens;
  totals.outputTokens += result.usage.outputTokens;

  const byId = new Map(rows.map((row) => [row.id, row]));
  const items = result.data.items;
  totals.judged += items.length;

  // 관련 없는 자료는 한 번에 표시한다
  const irrelevantIds = items.filter((item) => !item.relevant).map((item) => item.id);
  if (irrelevantIds.length > 0) {
    await db.update(articles).set({ clusteredAt: now, isRelevant: false }).where(inArray(articles.id, irrelevantIds));
  }
  const relevant = items.filter((item) => item.relevant);
  totals.relevant += relevant.length;
  if (relevant.length === 0) return;

  // AI가 기존 이슈에 연결한 자료는 글 뜻의 유사도로 한 번 더 확인한다 (엉뚱한 연결을 막기 위해)
  const issueVector = issueVectors;

  const newIssueIdByKey = new Map<string, number>();
  const links: { issueId: number; articleId: number; confidence: number; publishedAt: Date }[] = [];

  for (const item of relevant) {
    const row = byId.get(item.id)!;
    // 기존 이슈 연결은 확신도 0.7 이상(PRD Must① 규칙 2)이면서 글 뜻도 충분히 비슷할 때만 받아들인다
    // 후보 목록에 없던 번호는 받아들이지 않는다
    const accepted =
      item.issue_id > 0 &&
      issueIds.has(item.issue_id) &&
      item.confidence >= RULES.issue.sameIssueMinConfidence &&
      similarity(issueVector.get(item.issue_id)!, articleVector.get(item.id)!) >= RULES.issue.minLinkSimilarity;

    let issueId: number;
    if (accepted) {
      issueId = item.issue_id;
      totals.linkedToExisting++;
      const candidate = candidates.find((issue) => issue.id === issueId);
      if (candidate?.status === "보관") {
        await db.update(issues).set({ status: "진행 중", archivedAt: null }).where(eq(issues.id, issueId));
        candidate.status = "진행 중";
        totals.reopened++;
      }
    } else {
      if (item.issue_id > 0) totals.rejectedLinks++;
      // 연결이 거절되면 그 기사만의 새 이슈가 된다
      const key = item.issue_id > 0 ? `rejected-${row.id}` : item.new_issue_key.trim();
      const existing = newIssueIdByKey.get(key);
      if (existing) {
        issueId = existing;
      } else {
        // 제목이 한국어가 아니면(연결이 거절된 경우 등) 기사 요약 앞부분으로 대신한다
        const title = /[가-힣]/.test(item.new_issue_title) ? item.new_issue_title.trim() : (row.summaryKo ?? row.title).replace(/\.$/, "").slice(0, 30);
        const summary = item.new_issue_summary.trim() || row.summaryKo;
        const [created] = await db
          .insert(issues)
          .values({ title, summaryKo: summary, ...scopeValues(scope), lastArticleAt: row.publishedAt })
          .returning({ id: issues.id });
        issueId = created.id;
        newIssueIdByKey.set(key, issueId);
        candidates.unshift({ id: issueId, title, summaryKo: summary, status: "진행 중" });
        // 새 이슈의 뜻은 처음 기사의 뜻으로 둔다 (다음 묶음에서 바로 비교할 수 있게)
        issueVectors.set(issueId, articleVector.get(row.id)!);
        totals.newIssues++;
      }
    }
    links.push({ issueId, articleId: row.id, confidence: accepted ? item.confidence : 1, publishedAt: row.publishedAt });
    touched.add(issueId);
  }

  // 자료 1건은 이슈 1개에만 (issue_articles의 article_id 고유 제약이 지켜 준다)
  await db
    .insert(issueArticles)
    .values(links.map(({ issueId, articleId, confidence }) => ({ issueId, articleId, confidence })))
    .onConflictDoNothing();
  await db
    .update(articles)
    .set({ clusteredAt: now, isRelevant: true, linkedAt: now })
    .where(inArray(articles.id, links.map((link) => link.articleId)));

  // 이슈마다 가장 최근 자료 시각을 갱신한다 (날짜는 문자열로 넘겨야 SQL 안에서 시각으로 읽힌다)
  const latestByIssue = new Map<number, Date>();
  for (const link of links) {
    const current = latestByIssue.get(link.issueId);
    if (!current || link.publishedAt > current) latestByIssue.set(link.issueId, link.publishedAt);
  }
  for (const [issueId, latest] of latestByIssue) {
    const published = latest.toISOString();
    await db
      .update(issues)
      .set({ lastArticleAt: sql`greatest(coalesce(${issues.lastArticleAt}, ${published}::timestamptz), ${published}::timestamptz)`, updatedAt: now })
      .where(eq(issues.id, issueId));
  }
}

/**
 * 이번 실행에서 새로 생긴 이슈 중 기존(또는 다른 새) 이슈와 뜻이 매우 비슷한 것을 합친다.
 * 기사가 더 많은(같으면 먼저 생긴) 이슈를 남기고, 나머지 이슈의 기사를 옮긴 뒤 지운다.
 */
async function mergeDuplicates(
  db: Db,
  candidates: CandidateIssue[],
  created: Set<number>,
  touched: Set<number>,
  totals: ClusterResult,
): Promise<void> {
  if (created.size === 0) return;
  const pool = candidates.slice(0, RULES.issue.maxCandidateIssues * 2);
  const embedded = await embed(pool.map((issue) => `${issue.title}\n${issue.summaryKo ?? ""}`));
  totals.embeddingTokens += embedded.tokens;

  const counts = new Map<number, number>();
  const rows = await db
    .select({ issueId: issueArticles.issueId, n: sql<number>`count(*)::int` })
    .from(issueArticles)
    .where(inArray(issueArticles.issueId, pool.map((issue) => issue.id)))
    .groupBy(issueArticles.issueId);
  for (const row of rows) counts.set(row.issueId, row.n);

  // 합쳐질 이슈 → 남을 이슈 (연쇄를 따라가기 위한 간단한 묶음 표)
  const parent = new Map<number, number>();
  const root = (id: number): number => (parent.has(id) ? root(parent.get(id)!) : id);
  const keepFirst = (a: number, b: number) =>
    (counts.get(a) ?? 0) !== (counts.get(b) ?? 0) ? (counts.get(a) ?? 0) > (counts.get(b) ?? 0) : a < b;

  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (!created.has(pool[i].id) && !created.has(pool[j].id)) continue;
      if (similarity(embedded.vectors[i], embedded.vectors[j]) < RULES.issue.mergeMinSimilarity) continue;
      const a = root(pool[i].id);
      const b = root(pool[j].id);
      if (a === b) continue;
      const [keep, drop] = keepFirst(a, b) ? [a, b] : [b, a];
      parent.set(drop, keep);
    }
  }

  for (const drop of parent.keys()) {
    const keep = root(drop);
    await db.update(issueArticles).set({ issueId: keep }).where(eq(issueArticles.issueId, drop));
    await db
      .update(issues)
      .set({ lastArticleAt: sql`greatest(${issues.lastArticleAt}, (select last_article_at from issues where id = ${drop}))` })
      .where(eq(issues.id, keep));
    await db.delete(issues).where(eq(issues.id, drop));
    touched.delete(drop);
    touched.add(keep);
    const index = candidates.findIndex((issue) => issue.id === drop);
    if (index >= 0) candidates.splice(index, 1);
    totals.mergedIssues++;
  }
}

/** 이슈에 새로 들어온 1·2등급 자료가 같은 이슈의 "(카더라)" 자료를 확인해 주는지 판단한다 */
async function confirmRumors(db: Db, issueIds: number[], totals: ClusterResult, now: Date): Promise<void> {
  if (issueIds.length === 0) return;
  const linked = await db
    .select({
      issueId: issueArticles.issueId,
      id: articles.id,
      sourceId: articles.sourceId,
      title: articles.title,
      summaryKo: articles.summaryKo,
      isRumor: articles.isRumor,
      linkedAt: articles.linkedAt,
    })
    .from(issueArticles)
    .innerJoin(articles, eq(articles.id, issueArticles.articleId))
    .where(and(inArray(issueArticles.issueId, issueIds), eq(articles.status, "정상")));

  const byIssue = new Map<number, typeof linked>();
  for (const row of linked) byIssue.set(row.issueId, [...(byIssue.get(row.issueId) ?? []), row]);

  for (const rows of byIssue.values()) {
    const rumors = rows.filter((row) => row.isRumor);
    // 이번 실행에서 들어온 1·2등급 정식 자료만 확인 근거로 쓴다
    const confirmers = rows.filter(
      (row) => !row.isRumor && (TIER_BY_SOURCE.get(row.sourceId) ?? 3) <= 2 && row.linkedAt?.getTime() === now.getTime(),
    );
    if (rumors.length === 0 || confirmers.length === 0) continue;

    const confirmerIds = new Set(confirmers.map((row) => row.id));
    const rumorIds = new Set(rumors.map((row) => row.id));
    const result = await askJson({
      tier: "fast",
      schemaName: "rumor_confirmation",
      maxTokens: 400,
      system:
        "\"(카더라)\" 기사의 핵심 주장을 1·2등급 정식 기사가 사실로 확인해 주는지 판단한다. 같은 내용을 확인해 주는 정식 기사가 있으면 그 id를, 없으면 0을 confirmed_by에 넣는다. 확실하지 않으면 0이다.",
      prompt: JSON.stringify({
        rumors: rumors.map((row) => ({ id: row.id, title: row.title, summary: row.summaryKo ?? "" })),
        confirmed_articles: confirmers.map((row) => ({ id: row.id, source: NAME_BY_SOURCE.get(row.sourceId), title: row.title, summary: row.summaryKo ?? "" })),
      }),
      schema: RumorCheckSchema,
    });
    totals.inputTokens += result.usage.inputTokens;
    totals.outputTokens += result.usage.outputTokens;

    for (const item of result.data.items) {
      if (!rumorIds.has(item.rumor_id) || !confirmerIds.has(item.confirmed_by)) continue;
      await db.update(articles).set({ isRumor: false, rumorConfirmedBy: item.confirmed_by }).where(eq(articles.id, item.rumor_id));
      totals.rumorsConfirmed++;
    }
  }
}

/**
 * 요약이 끝났지만 아직 묶지 않은 실제 자료를 오래된 것부터 이슈로 묶는다.
 * 묶음은 차례로 처리한다 — 앞 묶음에서 생긴 새 이슈를 다음 묶음이 볼 수 있어야 하기 때문이다.
 */
export async function cluster(
  db: Db,
  limit: number = RULES.issue.clusterMaxPerRun,
  now: Date = new Date(),
  scope: RunScope = LIVE,
): Promise<ClusterResult> {
  const pending: PendingArticle[] = await db
    .select({
      id: articles.id,
      sourceId: articles.sourceId,
      title: articles.title,
      summaryKo: articles.summaryKo,
      isRumor: articles.isRumor,
      publishedAt: articles.publishedAt,
    })
    .from(articles)
    .where(and(inScope(articles, scope), isNotNull(articles.summaryKo), isNull(articles.clusteredAt), gte(articles.publishedAt, recentSince(now)), lte(articles.publishedAt, now)))
    .orderBy(asc(articles.publishedAt))
    .limit(limit);

  const totals: ClusterResult = {
    judged: 0,
    relevant: 0,
    linkedToExisting: 0,
    newIssues: 0,
    reopened: 0,
    rumorsConfirmed: 0,
    failedBatches: 0,
    mergedIssues: 0,
    rejectedLinks: 0,
    inputTokens: 0,
    outputTokens: 0,
    embeddingTokens: 0,
  };
  const candidates = await loadCandidateIssues(db, now, scope);
  const touched = new Set<number>();
  const size = RULES.issue.clusterBatchSize;

  const batches: PendingArticle[][] = [];
  for (let i = 0; i < pending.length; i += size) batches.push(pending.slice(i, i + size));
  const before = new Set(candidates.map((issue) => issue.id));
  const issueVectors = new Map<number, number[]>();

  // 여러 묶음을 동시에 처리한다. 앞 묶음에서 생긴 새 이슈는 공유 후보 목록에 바로 들어가 다음 묶음이 본다.
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        await clusterBatch(db, batch, candidates, touched, totals, now, issueVectors, scope);
      } catch (error) {
        // 실패한 자료는 clustered_at이 비어 있어 다음 실행 때 다시 처리된다
        totals.failedBatches++;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  ⚠️  묶음 실패 (자료 ${batch[0].id}~${batch.at(-1)!.id}): ${message.replace(/\s+/g, " ").slice(0, 400)}`);
      }
      done++;
      if (done % 20 === 0) console.log(`  … ${Math.min(done * size, pending.length)}/${pending.length}건 처리`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RULES.issue.clusterConcurrency, batches.length) }, worker));

  // 동시에 처리하다 같은 사건이 두 이슈로 갈라졌을 수 있어 합친다
  const created = candidates.filter((issue) => !before.has(issue.id)).map((issue) => issue.id);
  await mergeDuplicates(db, candidates, new Set(created), touched, totals);

  await confirmRumors(db, [...touched], totals, now);
  return totals;
}

/** 요약은 끝났지만 아직 묶지 않은 최근 실제 자료 수 */
export function countUnclustered(db: Db, now: Date = new Date(), scope: RunScope = LIVE): Promise<number> {
  return db.$count(
    articles,
    and(inScope(articles, scope), isNotNull(articles.summaryKo), isNull(articles.clusteredAt), gte(articles.publishedAt, recentSince(now)), lte(articles.publishedAt, now)),
  );
}

/** 묶기 대상이 되는 가장 오래된 공개 시각 */
function recentSince(now: Date): Date {
  return new Date(now.getTime() - RULES.collection.maxArticleAgeDays * 86_400_000);
}
