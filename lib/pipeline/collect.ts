// 1단계 수집: 출처 목록(config/sources.json)에서 새 자료를 가져와 articles 표에 중복 없이 저장한다.
// Design Ref: §7.1 1단계 — RSS·공식 페이지 읽기, 주소 기준 중복 제거, 공개·수집 시각 기록.
// Plan SC: 수집 속도 — 공개 시각(published_at)과 수집 시각(fetched_at)을 함께 남겨 "공개 후 3시간 이내 반영"을 잴 수 있게 한다.
// 원문 전문은 저장하지 않고 제목·링크·짧은 발췌만 저장한다 (PRD 7번).

import * as cheerio from "cheerio";
import { sql } from "drizzle-orm";
import Parser from "rss-parser";
import { RULES } from "../config/rules";
import { SOURCES, type Source } from "../config/sources";
import type { Db } from "../db/client";
import { articles, sources as sourcesTable } from "../db/schema";

export type CollectedItem = {
  sourceId: string;
  url: string;
  title: string;
  publishedAt: Date;
  excerpt: string | null;
  language: string;
};

export type SourceResult = {
  sourceId: string;
  /** 출처에서 읽은 글 수 (기준 시각 이후 글은 뺀 수) */
  fetched: number;
  /** 새로 저장된 글 수 (이미 있던 글은 건너뜀) */
  inserted: number;
  /** 최근에 읽어서 이번에는 건너뜀 */
  skipped?: boolean;
  error?: string;
};

export type CollectOptions = {
  db: Db;
  /** 기준 시각 — 이 시각 이후에 공개된 글은 넣지 않는다 (과거 재실행용) */
  asOf?: Date;
  /** true면 데이터베이스에 쓰지 않고 읽기만 한다 */
  dryRun?: boolean;
  /** 지금 시각 (시험용으로 바꿀 수 있게) */
  now?: Date;
};

const rssParser = new Parser();

// ── 공용 도구 ────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": RULES.collection.userAgent },
    signal: AbortSignal.timeout(RULES.collection.fetchTimeoutMs),
  });
  if (!response.ok) throw new Error(`응답 ${response.status}`);
  return response.text();
}

/** HTML 태그와 공백을 정리하고 짧은 발췌로 자른다 */
function toExcerpt(text: string | undefined | null): string | null {
  if (!text) return null;
  const plain = cheerio.load(`<div>${text}</div>`)("div").text().replace(/\s+/g, " ").trim();
  if (!plain) return null;
  const max = RULES.collection.excerptMaxChars;
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** 이 페이지 주소에서 글을 가리키는 데 필요 없는 값(추적용·목록 위치)을 뺀다 */
const VOLATILE_PARAMS = /^(utm_|fbclid$|gclid$|nPage$|vlist_no_npage$|keyField$|keyWord$|orderby$|tag$|b_list$)/;

export function normalizeUrl(href: string, base?: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (VOLATILE_PARAMS.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── 출처별 읽기 ───────────────────────────────────────────────

async function readRss(source: Source, url: string, now: Date): Promise<CollectedItem[]> {
  const feed = await rssParser.parseString(await fetchText(url));
  const items: CollectedItem[] = [];
  for (const item of feed.items) {
    const link = item.link ? normalizeUrl(item.link, url) : null;
    const title = item.title?.trim();
    if (!link || !title) continue;
    items.push({
      sourceId: source.id,
      url: link,
      title,
      // 날짜가 없는 글은 처음 발견한 시각을 공개 시각으로 쓴다
      publishedAt: parseDate(item.isoDate ?? item.pubDate) ?? now,
      excerpt: toExcerpt(item.contentSnippet ?? item.summary ?? item.content),
      language: source.language,
    });
  }
  return items;
}

/** 페이지 읽기 출처별 규칙 — 페이지 구조가 바뀌면 여기만 고친다 */
const PAGE_READERS: Record<string, (html: string, pageUrl: string, now: Date) => Omit<CollectedItem, "sourceId" | "language">[]> = {
  // KDI 연구보고서 목록: 목록에 발간일이 없어 처음 발견한 시각을 공개 시각으로 쓴다
  kdi: (html, pageUrl, now) => {
    const $ = cheerio.load(html);
    return $(".page_list-group li > a[href*='reportView']")
      .toArray()
      .flatMap((element) => {
        const anchor = $(element);
        const url = normalizeUrl(anchor.attr("href") ?? "", pageUrl);
        const title = anchor.find(".rpt_tit strong").text().trim();
        if (!url || !title) return [];
        const pubNo = new URL(url).searchParams.get("pub_no");
        const summary = pubNo ? $(`.move_summary_view${pubNo} .editor-template`).text() : "";
        return [{ url, title, publishedAt: now, excerpt: toExcerpt(summary) }];
      });
  },
  // KIEP 발간물 목록: 제목, 요약 문장, 발간일(YYYY.MM.DD)
  kiep: (html, pageUrl, now) => {
    const $ = cheerio.load(html);
    return $(".desc")
      .toArray()
      .flatMap((element) => {
        const box = $(element);
        const anchor = box.find("a[href*='act=view']").first();
        const url = normalizeUrl(anchor.attr("href") ?? "", pageUrl);
        const title = anchor.find(".title").text().trim();
        if (!url || !title) return [];
        const dateText = box.find(".info").text().match(/(\d{4})\.(\d{2})\.(\d{2})/);
        // 발간일만 있으므로 한국 시간 0시로 둔다
        const publishedAt = dateText ? new Date(`${dateText[1]}-${dateText[2]}-${dateText[3]}T00:00:00+09:00`) : now;
        return [{ url, title, publishedAt, excerpt: toExcerpt(box.find(".txt").text()) }];
      });
  },
};

async function readPage(source: Source, url: string, now: Date): Promise<CollectedItem[]> {
  const reader = PAGE_READERS[source.id];
  if (!reader) throw new Error(`페이지 읽기 규칙이 없습니다: ${source.id}`);
  const found = reader(await fetchText(url), url, now);
  if (found.length === 0) throw new Error("페이지에서 글을 찾지 못했습니다 (페이지 구조가 바뀌었을 수 있음)");
  return found.map((item) => ({ ...item, sourceId: source.id, language: source.language }));
}

/** 출처 하나의 모든 주소를 읽어 주소 기준으로 중복을 뺀 목록을 돌려준다 */
export async function fetchSource(source: Source, now: Date = new Date()): Promise<CollectedItem[]> {
  const lists = await Promise.all(
    source.urls.map((url) => (source.method === "rss" ? readRss(source, url, now) : readPage(source, url, now))),
  );
  const byUrl = new Map<string, CollectedItem>();
  for (const item of lists.flat()) if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  return [...byUrl.values()];
}

// ── 데이터베이스 저장 ──────────────────────────────────────────

/** config/sources.json의 출처 목록을 sources 표에 맞춘다 */
async function syncSources(db: Db): Promise<Map<string, Date | null>> {
  await db
    .insert(sourcesTable)
    .values(SOURCES.map((source) => ({ id: source.id, name: source.name, url: source.urls[0], method: source.method, tier: source.tier })))
    .onConflictDoUpdate({
      target: sourcesTable.id,
      set: { name: sql`excluded.name`, url: sql`excluded.url`, method: sql`excluded.method`, tier: sql`excluded.tier` },
    });
  const rows = await db.select({ id: sourcesTable.id, lastSuccessAt: sourcesTable.lastSuccessAt }).from(sourcesTable);
  return new Map(rows.map((row) => [row.id, row.lastSuccessAt]));
}

/**
 * 모든 출처에서 자료를 모아 저장한다. 한 출처가 실패해도 나머지는 계속한다 (DESIGN 10장).
 */
export async function collect({ db, asOf, dryRun = false, now = new Date() }: CollectOptions): Promise<SourceResult[]> {
  const lastSuccess = dryRun ? new Map<string, Date | null>() : await syncSources(db);

  return Promise.all(
    SOURCES.map(async (source): Promise<SourceResult> => {
      // 페이지 읽기 출처는 정해진 시간 안에 다시 읽지 않는다 (과거 재실행은 예외)
      const last = lastSuccess.get(source.id);
      if (!asOf && source.minIntervalHours && last && now.getTime() - last.getTime() < source.minIntervalHours * 3_600_000) {
        return { sourceId: source.id, fetched: 0, inserted: 0, skipped: true };
      }

      try {
        const items = (await fetchSource(source, now)).filter((item) => !asOf || item.publishedAt <= asOf);
        let inserted = 0;
        if (!dryRun && items.length > 0) {
          const rows = await db
            .insert(articles)
            .values(items.map((item) => ({ ...item, fetchedAt: now, mode: "live" as const })))
            .onConflictDoNothing()
            .returning({ id: articles.id });
          inserted = rows.length;
        }
        if (!dryRun) {
          await db
            .update(sourcesTable)
            .set({ lastSuccessAt: now, lastError: null })
            .where(sql`${sourcesTable.id} = ${source.id}`);
        }
        return { sourceId: source.id, fetched: items.length, inserted };
      } catch (error) {
        const message = error instanceof Error && error.name === "TimeoutError" ? "시간 초과" : error instanceof Error ? error.message : String(error);
        if (!dryRun) {
          await db
            .update(sourcesTable)
            .set({ lastFailureAt: now, lastError: message })
            .where(sql`${sourcesTable.id} = ${source.id}`);
        }
        return { sourceId: source.id, fetched: 0, inserted: 0, error: message };
      }
    }),
  );
}
