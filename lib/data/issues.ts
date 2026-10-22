// 화면에서 쓰는 데이터 조회 (서버 전용).
// Design Ref: §7.4 — 화면은 실제(live) 데이터만 읽는다.

import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { GRADES, RULES, type Grade } from "@/lib/config/rules";
import { SOURCES } from "@/lib/config/sources";
import { getDb } from "@/lib/db/client";
import { articles, issueArticles, issues, runs, scores } from "@/lib/db/schema";

const SOURCE_BY_ID = new Map(SOURCES.map((source) => [source.id, source]));

export type IssueListItem = {
  id: number;
  title: string;
  summaryKo: string | null;
  grade: Grade;
  score: number;
  isBorderline: boolean;
  lastArticleAt: Date | null;
  articleCount: number;
  recentCount: number;
  impact: number | null;
  likelihood: number | null;
  velocity: number | null;
};

/** 최근 14일 안에 기사가 들어온 진행 중 이슈 — 등급 높은 순, 같은 등급이면 점수 높은 순 */
export async function listIssues(grade?: Grade): Promise<IssueListItem[]> {
  const db = getDb();
  const since = new Date(Date.now() - RULES.collection.maxArticleAgeDays * 86_400_000);
  const recentSince = new Date(Date.now() - 24 * 3_600_000);
  const rows = await db
    .select({
      id: issues.id,
      title: issues.title,
      summaryKo: issues.summaryKo,
      grade: issues.grade,
      score: issues.score,
      isBorderline: issues.isBorderline,
      lastArticleAt: issues.lastArticleAt,
      articleCount: count(issueArticles.articleId),
      recentCount: sql<number>`count(*) filter (where ${articles.publishedAt} >= ${recentSince.toISOString()}::timestamptz)::int`,
    })
    .from(issues)
    .innerJoin(issueArticles, eq(issueArticles.issueId, issues.id))
    .innerJoin(articles, eq(articles.id, issueArticles.articleId))
    .where(
      and(
        eq(issues.mode, "live"),
        eq(issues.status, "진행 중"),
        gte(issues.lastArticleAt, since),
        grade ? eq(issues.grade, grade) : undefined,
      ),
    )
    .groupBy(issues.id)
    .orderBy(desc(sql`array_position(array['관심','주의','경계','심각']::grade[], ${issues.grade})`), desc(issues.score), desc(issues.lastArticleAt))
    .limit(200);

  // 이슈마다 가장 최근 점수의 세 축
  const latest = rows.length
    ? await db
        .selectDistinctOn([scores.issueId], { issueId: scores.issueId, impact: scores.impact, likelihood: scores.likelihood, velocity: scores.velocity })
        .from(scores)
        .where(inArray(scores.issueId, rows.map((row) => row.id)))
        .orderBy(scores.issueId, desc(scores.createdAt))
    : [];
  const axes = new Map(latest.map((row) => [row.issueId, row]));
  return rows.map((row) => ({
    ...row,
    impact: axes.get(row.id)?.impact ?? null,
    likelihood: axes.get(row.id)?.likelihood ?? null,
    velocity: axes.get(row.id)?.velocity ?? null,
  }));
}

/** 등급별 이슈 수 (탭에 표시) */
export async function countByGrade(): Promise<Record<Grade, number>> {
  const db = getDb();
  const since = new Date(Date.now() - RULES.collection.maxArticleAgeDays * 86_400_000);
  const rows = await db
    .select({ grade: issues.grade, n: count() })
    .from(issues)
    .where(and(eq(issues.mode, "live"), eq(issues.status, "진행 중"), gte(issues.lastArticleAt, since)))
    .groupBy(issues.grade);
  const result = Object.fromEntries(GRADES.map((grade) => [grade, 0])) as Record<Grade, number>;
  for (const row of rows) result[row.grade] = row.n;
  return result;
}

/** 마지막으로 성공한 실제 수집 시각 */
export async function lastSuccessfulRun(): Promise<Date | null> {
  const db = getDb();
  const [row] = await db
    .select({ finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(eq(runs.mode, "live"), eq(runs.success, true)))
    .orderBy(desc(runs.finishedAt))
    .limit(1);
  return row?.finishedAt ?? null;
}

export type TimelineArticle = {
  id: number;
  sourceName: string;
  tier: number;
  region: string;
  title: string;
  summaryKo: string | null;
  url: string;
  publishedAt: Date;
  isRumor: boolean;
  status: string;
};

/** 이슈 상세: 이슈, 최근 점수, 타임라인 */
export async function getIssue(id: number) {
  const db = getDb();
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, id), eq(issues.mode, "live")));
  if (!issue) return null;

  const [score] = await db.select().from(scores).where(eq(scores.issueId, id)).orderBy(desc(scores.createdAt)).limit(1);
  const rows = await db
    .select({
      id: articles.id,
      sourceId: articles.sourceId,
      title: articles.title,
      summaryKo: articles.summaryKo,
      url: articles.url,
      publishedAt: articles.publishedAt,
      isRumor: articles.isRumor,
      status: articles.status,
    })
    .from(issueArticles)
    .innerJoin(articles, eq(articles.id, issueArticles.articleId))
    .where(eq(issueArticles.issueId, id))
    .orderBy(desc(articles.publishedAt));

  const timeline: TimelineArticle[] = rows.map((row) => {
    const source = SOURCE_BY_ID.get(row.sourceId);
    return {
      id: row.id,
      sourceName: source?.name ?? row.sourceId,
      tier: source?.tier ?? 3,
      region: source?.region ?? "",
      title: row.title,
      summaryKo: row.summaryKo,
      url: row.url,
      publishedAt: row.publishedAt,
      isRumor: row.isRumor,
      status: row.status,
    };
  });
  return { issue, score: score ?? null, timeline };
}
