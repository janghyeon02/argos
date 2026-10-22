// 아르고스 데이터베이스 표 정의 (Drizzle ORM).
// Design Ref: §8 데이터 모델 — 표와 칸은 DESIGN.md 8장 표와 같게 유지한다.
// 실제(live)와 과거 검증(backtest) 데이터는 mode 칸으로 구분하고, 검증 데이터는 backtest_run_id로 실행별로 묶는다.

import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { GRADES, RULES } from "../config/rules";

// ── 선택지(열거형) ──────────────────────────────────────────────

export const modeEnum = pgEnum("mode", ["live", "backtest"]);
export const gradeEnum = pgEnum("grade", GRADES);
export const sourceMethodEnum = pgEnum("source_method", ["rss", "page"]);
export const articleStatusEnum = pgEnum("article_status", ["정상", "정정", "철회"]);
export const issueStatusEnum = pgEnum("issue_status", ["진행 중", "보관"]);
export const scenarioKindEnum = pgEnum("scenario_kind", RULES.scenario.kinds);
export const signalStateEnum = pgEnum("signal_state", ["켜짐", "꺼짐"]);
export const alertKindEnum = pgEnum("alert_kind", [
  "신규",
  "상향",
  "신호",
  "최고 시나리오 변경",
  "심각 하향",
  "기준표 변경",
]);
export const alertStatusEnum = pgEnum("alert_status", ["발송", "보류", "폐기", "실패"]);
export const caseNoteOriginEnum = pgEnum("case_note_origin", ["검증", "보관", "피드백"]);

// 자동 증가 번호 (자바스크립트 숫자로 다룬다)
const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ref = (name: string) => bigint(name, { mode: "number" });

// ── 실행 기록 ──────────────────────────────────────────────────
// 매시간 실행과 과거 검증 실행을 모두 남긴다. 과거 검증의 backtest_run_id는 이 표의 id를 가리킨다.
export const runs = pgTable("runs", {
  id: id(),
  mode: modeEnum("mode").notNull().default("live"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  success: boolean("success"),
  durationMs: integer("duration_ms"),
  /** 단계별 처리 건수 */
  counts: jsonb("counts").$type<Record<string, number>>(),
  error: text("error"),
  /** 과거 검증: 기준 시각과 사용한 기준표 버전 */
  asOf: timestamp("as_of", { withTimezone: true }),
  rubricVersion: integer("rubric_version"),
});

// ── 출처 ──────────────────────────────────────────────────────
export const sources = pgTable(
  "sources",
  {
    /** config/sources.json의 출처 키 (예: fed, ecb) */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: sourceMethodEnum("method").notNull(),
    tier: smallint("tier").notNull(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [check("sources_tier_check", sql`${t.tier} between 1 and 3`)],
);

// ── 수집한 자료 ────────────────────────────────────────────────
export const articles = pgTable(
  "articles",
  {
    id: id(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    url: text("url").notNull(),
    title: text("title").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** 이슈 카드에 반영된 시각 — "공개 후 3시간 이내 반영" 측정용 */
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    /** 원문 전문은 저장하지 않는다 (PRD 7번) */
    excerpt: text("excerpt"),
    summaryKo: text("summary_ko"),
    language: text("language"),
    isRumor: boolean("is_rumor").notNull().default(false),
    /** "(카더라)"를 확인해 준 1·2등급 자료 */
    rumorConfirmedBy: ref("rumor_confirmed_by").references((): AnyPgColumn => articles.id),
    status: articleStatusEnum("status").notNull().default("정상"),
    /** 이 자료를 정정·철회한 자료 */
    correctedBy: ref("corrected_by").references((): AnyPgColumn => articles.id),
    mode: modeEnum("mode").notNull().default("live"),
    backtestRunId: ref("backtest_run_id").references(() => runs.id),
  },
  (t) => [
    unique("articles_url_unique").on(t.url, t.mode, t.backtestRunId).nullsNotDistinct(),
    index("articles_published_idx").on(t.mode, t.publishedAt),
  ],
);

// ── 이슈 카드 ──────────────────────────────────────────────────
export const issues = pgTable(
  "issues",
  {
    id: id(),
    title: text("title").notNull(),
    summaryKo: text("summary_ko"),
    grade: gradeEnum("grade").notNull().default("관심"),
    score: real("score").notNull().default(0),
    isBorderline: boolean("is_borderline").notNull().default(false),
    status: issueStatusEnum("status").notNull().default("진행 중"),
    lastArticleAt: timestamp("last_article_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** 하향 2회 확인용: 연속으로 낮은 등급이 나온 실행 수 */
    pendingDowngradeRuns: smallint("pending_downgrade_runs").notNull().default(0),
    mode: modeEnum("mode").notNull().default("live"),
    backtestRunId: ref("backtest_run_id").references(() => runs.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("issues_list_idx").on(t.mode, t.status, t.grade, t.score)],
);

// ── 이슈와 자료 연결 (자료 1건은 이슈 1개에만) ─────────────────────
export const issueArticles = pgTable(
  "issue_articles",
  {
    issueId: ref("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    articleId: ref("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    /** 같은 이슈라고 판단한 확신도 (0~1) */
    confidence: real("confidence"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.articleId] }), unique("issue_articles_article_unique").on(t.articleId)],
);

// ── 평가 기준표 버전 ───────────────────────────────────────────
export const rubricVersions = pgTable("rubric_versions", {
  version: integer("version").primaryKey(),
  content: text("content").notNull(),
  applied: boolean("applied").notNull().default(false),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  /** 재검증 결과 요약 */
  rerunResult: jsonb("rerun_result"),
  createdAt: createdAt(),
});

// ── 점수 이력 ──────────────────────────────────────────────────
/** 6개 경로별 점수: 5번 평가 각각과 중앙값 */
export type ChannelScores = { runs: Record<string, number>[]; median: Record<string, number> };
/** 축별 근거 자료 번호 (속도는 집계 건수) */
export type ScoreEvidence = { impact: number[]; likelihood: number[]; velocity: { weightedCount: number; baseline: number } };

export const scores = pgTable(
  "scores",
  {
    id: id(),
    issueId: ref("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    runId: ref("run_id").references(() => runs.id),
    rubricVersion: integer("rubric_version").references(() => rubricVersions.version),
    channelScores: jsonb("channel_scores").$type<ChannelScores>(),
    systemicBonus: smallint("systemic_bonus").notNull().default(0),
    impact: real("impact").notNull(),
    likelihood: real("likelihood").notNull(),
    velocity: real("velocity").notNull(),
    /** 5번 평가 각각의 종합 점수 */
    compositeRuns: jsonb("composite_runs").$type<number[]>(),
    composite: real("composite").notNull(),
    grade: gradeEnum("grade").notNull(),
    isBorderline: boolean("is_borderline").notNull().default(false),
    /** AI를 다시 부르지 않고 직전 평가를 재사용한 재계산인지 */
    reusedEvaluation: boolean("reused_evaluation").notNull().default(false),
    evidence: jsonb("evidence").$type<ScoreEvidence>(),
    mode: modeEnum("mode").notNull().default("live"),
    backtestRunId: ref("backtest_run_id").references(() => runs.id),
    createdAt: createdAt(),
  },
  (t) => [index("scores_issue_idx").on(t.issueId, t.createdAt)],
);

// ── 시나리오 버전 ──────────────────────────────────────────────
export type ScenarioBody = {
  kind: (typeof RULES.scenario.kinds)[number];
  probability: number;
  path: string;
  koreaImpact: { channel: string; direction: "↑" | "↓"; size: "소" | "중" | "대" }[];
  checklist: string[];
};

export const scenarios = pgTable(
  "scenarios",
  {
    id: id(),
    issueId: ref("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: jsonb("body").$type<ScenarioBody[]>().notNull(),
    changeReason: text("change_reason"),
    evidenceArticleIds: jsonb("evidence_article_ids").$type<number[]>(),
    mode: modeEnum("mode").notNull().default("live"),
    backtestRunId: ref("backtest_run_id").references(() => runs.id),
    createdAt: createdAt(),
  },
  (t) => [unique("scenarios_issue_version_unique").on(t.issueId, t.version)],
);

// ── 갈림길 신호 (id가 고정 번호) ─────────────────────────────────
export const scenarioSignals = pgTable(
  "scenario_signals",
  {
    id: id(),
    issueId: ref("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    scenarioKind: scenarioKindEnum("scenario_kind").notNull(),
    indicator: text("indicator").notNull(),
    condition: text("condition").notNull(),
    rationale: text("rationale").notNull(),
    state: signalStateEnum("state").notNull().default("꺼짐"),
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("scenario_signals_issue_idx").on(t.issueId)],
);

// ── 알림 기록 ──────────────────────────────────────────────────
export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    /** 기준표 변경 알림은 이슈가 없다 */
    issueId: ref("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    kind: alertKindEnum("kind").notNull(),
    grade: gradeEnum("grade"),
    status: alertStatusEnum("status").notNull(),
    /** 판정 시각 — "판정 후 10분 이내 발송" 측정용 */
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("alerts_issue_idx").on(t.issueId, t.decidedAt), index("alerts_status_idx").on(t.status)],
);

// ── 사용자 피드백 ──────────────────────────────────────────────
export const feedback = pgTable("feedback", {
  id: id(),
  issueId: ref("issue_id")
    .notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  userGrade: gradeEnum("user_grade").notNull(),
  memo: text("memo"),
  createdAt: createdAt(),
});

// ── 사례 기록 ──────────────────────────────────────────────────
export const caseNotes = pgTable("case_notes", {
  id: id(),
  issueId: ref("issue_id").references(() => issues.id, { onDelete: "set null" }),
  /** 과거 검증 사례 키 (예: uk-2022) */
  caseKey: text("case_key"),
  lesson: text("lesson").notNull(),
  origin: caseNoteOriginEnum("origin").notNull(),
  mode: modeEnum("mode").notNull().default("live"),
  backtestRunId: ref("backtest_run_id").references(() => runs.id),
  createdAt: createdAt(),
});

// ── 과거 검증 결과 ─────────────────────────────────────────────
export const backtestResults = pgTable("backtest_results", {
  id: id(),
  runId: ref("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  caseKey: text("case_key").notNull(),
  rubricVersion: integer("rubric_version").references(() => rubricVersions.version),
  /** 시간대별 종합 점수·등급 */
  timeline: jsonb("timeline").$type<{ at: string; score: number; grade: string }[]>(),
  leadTimeHours: real("lead_time_hours"),
  onTarget: boolean("on_target"),
  falseAlarms: integer("false_alarms"),
  humanAgreement: real("human_agreement"),
  /** 국가·기관 이름을 가린 비교 실험인지 */
  masked: boolean("masked").notNull().default(false),
  createdAt: createdAt(),
});

// ── 로그인 시도 제한 ───────────────────────────────────────────
export const loginAttempts = pgTable("login_attempts", {
  ip: text("ip").primaryKey(),
  failedCount: smallint("failed_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
