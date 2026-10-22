ALTER TABLE "articles" ADD COLUMN "clustered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "is_relevant" boolean;