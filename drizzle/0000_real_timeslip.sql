CREATE TYPE "public"."alert_kind" AS ENUM('신규', '상향', '신호', '최고 시나리오 변경', '심각 하향', '기준표 변경');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('발송', '보류', '폐기', '실패');--> statement-breakpoint
CREATE TYPE "public"."article_status" AS ENUM('정상', '정정', '철회');--> statement-breakpoint
CREATE TYPE "public"."case_note_origin" AS ENUM('검증', '보관', '피드백');--> statement-breakpoint
CREATE TYPE "public"."grade" AS ENUM('관심', '주의', '경계', '심각');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('진행 중', '보관');--> statement-breakpoint
CREATE TYPE "public"."mode" AS ENUM('live', 'backtest');--> statement-breakpoint
CREATE TYPE "public"."scenario_kind" AS ENUM('기본', '악화', '극단');--> statement-breakpoint
CREATE TYPE "public"."signal_state" AS ENUM('켜짐', '꺼짐');--> statement-breakpoint
CREATE TYPE "public"."source_method" AS ENUM('rss', 'page');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" bigint,
	"kind" "alert_kind" NOT NULL,
	"grade" "grade",
	"status" "alert_status" NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "articles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_at" timestamp with time zone,
	"excerpt" text,
	"summary_ko" text,
	"language" text,
	"is_rumor" boolean DEFAULT false NOT NULL,
	"rumor_confirmed_by" bigint,
	"status" "article_status" DEFAULT '정상' NOT NULL,
	"corrected_by" bigint,
	"mode" "mode" DEFAULT 'live' NOT NULL,
	"backtest_run_id" bigint,
	CONSTRAINT "articles_url_unique" UNIQUE NULLS NOT DISTINCT("url","mode","backtest_run_id")
);
--> statement-breakpoint
CREATE TABLE "backtest_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backtest_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"case_key" text NOT NULL,
	"rubric_version" integer,
	"timeline" jsonb,
	"lead_time_hours" real,
	"on_target" boolean,
	"false_alarms" integer,
	"human_agreement" real,
	"masked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "case_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" bigint,
	"case_key" text,
	"lesson" text NOT NULL,
	"origin" "case_note_origin" NOT NULL,
	"mode" "mode" DEFAULT 'live' NOT NULL,
	"backtest_run_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" bigint NOT NULL,
	"user_grade" "grade" NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_articles" (
	"issue_id" bigint NOT NULL,
	"article_id" bigint NOT NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_articles_issue_id_article_id_pk" PRIMARY KEY("issue_id","article_id"),
	CONSTRAINT "issue_articles_article_unique" UNIQUE("article_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issues_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"summary_ko" text,
	"grade" "grade" DEFAULT '관심' NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"is_borderline" boolean DEFAULT false NOT NULL,
	"status" "issue_status" DEFAULT '진행 중' NOT NULL,
	"last_article_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"pending_downgrade_runs" smallint DEFAULT 0 NOT NULL,
	"mode" "mode" DEFAULT 'live' NOT NULL,
	"backtest_run_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"ip" text PRIMARY KEY NOT NULL,
	"failed_count" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rubric_versions" (
	"version" integer PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"rerun_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mode" "mode" DEFAULT 'live' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"success" boolean,
	"duration_ms" integer,
	"counts" jsonb,
	"error" text,
	"as_of" timestamp with time zone,
	"rubric_version" integer
);
--> statement-breakpoint
CREATE TABLE "scenario_signals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scenario_signals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" bigint NOT NULL,
	"scenario_kind" "scenario_kind" NOT NULL,
	"indicator" text NOT NULL,
	"condition" text NOT NULL,
	"rationale" text NOT NULL,
	"state" "signal_state" DEFAULT '꺼짐' NOT NULL,
	"state_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scenarios_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"change_reason" text,
	"evidence_article_ids" jsonb,
	"mode" "mode" DEFAULT 'live' NOT NULL,
	"backtest_run_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenarios_issue_version_unique" UNIQUE("issue_id","version")
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scores_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" bigint NOT NULL,
	"run_id" bigint,
	"rubric_version" integer,
	"channel_scores" jsonb,
	"systemic_bonus" smallint DEFAULT 0 NOT NULL,
	"impact" real NOT NULL,
	"likelihood" real NOT NULL,
	"velocity" real NOT NULL,
	"composite_runs" jsonb,
	"composite" real NOT NULL,
	"grade" "grade" NOT NULL,
	"is_borderline" boolean DEFAULT false NOT NULL,
	"reused_evaluation" boolean DEFAULT false NOT NULL,
	"evidence" jsonb,
	"mode" "mode" DEFAULT 'live' NOT NULL,
	"backtest_run_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"method" "source_method" NOT NULL,
	"tier" smallint NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_tier_check" CHECK ("sources"."tier" between 1 and 3)
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_rumor_confirmed_by_articles_id_fk" FOREIGN KEY ("rumor_confirmed_by") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_corrected_by_articles_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_backtest_run_id_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_rubric_version_rubric_versions_version_fk" FOREIGN KEY ("rubric_version") REFERENCES "public"."rubric_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_backtest_run_id_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_articles" ADD CONSTRAINT "issue_articles_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_articles" ADD CONSTRAINT "issue_articles_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_backtest_run_id_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_signals" ADD CONSTRAINT "scenario_signals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_backtest_run_id_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_rubric_version_rubric_versions_version_fk" FOREIGN KEY ("rubric_version") REFERENCES "public"."rubric_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_backtest_run_id_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_issue_idx" ON "alerts" USING btree ("issue_id","decided_at");--> statement-breakpoint
CREATE INDEX "alerts_status_idx" ON "alerts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "articles_published_idx" ON "articles" USING btree ("mode","published_at");--> statement-breakpoint
CREATE INDEX "issues_list_idx" ON "issues" USING btree ("mode","status","grade","score");--> statement-breakpoint
CREATE INDEX "scenario_signals_issue_idx" ON "scenario_signals" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "scores_issue_idx" ON "scores" USING btree ("issue_id","created_at");