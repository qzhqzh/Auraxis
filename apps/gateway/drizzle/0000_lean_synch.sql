CREATE TYPE "public"."conversation_status" AS ENUM('open', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."message_content_type" AS ENUM('text', 'tool_result', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."tool_call_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'denied', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."tool_risk_level" AS ENUM('read_only', 'diagnostic', 'create', 'update', 'destructive');--> statement-breakpoint
CREATE TYPE "public"."tool_type" AS ENUM('internal', 'script');--> statement-breakpoint
CREATE TYPE "public"."trace_status" AS ENUM('started', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "agent_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"app_id" varchar(120) NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"phase" varchar(120) NOT NULL,
	"status" "trace_status" NOT NULL,
	"payload" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "assistant_app_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assistant_app_id" uuid NOT NULL,
	"key_id" varchar(120) NOT NULL,
	"secret_hash" text NOT NULL,
	"issuer" varchar(200) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" varchar(120) NOT NULL,
	"name" varchar(200) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" varchar(120) NOT NULL,
	"tenant_id" varchar(120),
	"external_user_id" varchar(200) NOT NULL,
	"display_name" varchar(200),
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_states" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"current_intent" varchar(120),
	"stage" varchar(120),
	"entities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending_tool_call_id" uuid,
	"confidence" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" varchar(120) NOT NULL,
	"tenant_id" varchar(120),
	"external_user_id" varchar(200),
	"visitor_id" varchar(200),
	"source_url" text,
	"page_title" text,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"summary" text,
	"trace_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"content_type" "message_content_type" DEFAULT 'text' NOT NULL,
	"structured_payload" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_usage" jsonb,
	"model_name" varchar(120),
	"trace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"trace_id" uuid NOT NULL,
	"app_id" varchar(120) NOT NULL,
	"tenant_id" varchar(120),
	"external_user_id" varchar(200),
	"tool_name" varchar(160) NOT NULL,
	"tool_version" varchar(40) NOT NULL,
	"risk_level" "tool_risk_level" NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"status" "tool_call_status" DEFAULT 'pending' NOT NULL,
	"error_code" varchar(120),
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"version" varchar(40) NOT NULL,
	"type" "tool_type" NOT NULL,
	"description" text NOT NULL,
	"risk_level" "tool_risk_level" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"required_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timeout_ms" integer DEFAULT 5000 NOT NULL,
	"max_output_chars" integer DEFAULT 4000 NOT NULL,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_app_keys" ADD CONSTRAINT "assistant_app_keys_assistant_app_id_assistant_apps_id_fk" FOREIGN KEY ("assistant_app_id") REFERENCES "public"."assistant_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_traces_trace_idx" ON "agent_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "agent_traces_conversation_idx" ON "agent_traces" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_traces_phase_idx" ON "agent_traces" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "assistant_app_keys_app_idx" ON "assistant_app_keys" USING btree ("assistant_app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_app_keys_key_id_idx" ON "assistant_app_keys" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_apps_app_id_idx" ON "assistant_apps" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_user_identities_user_idx" ON "assistant_user_identities" USING btree ("app_id","tenant_id","external_user_id");--> statement-breakpoint
CREATE INDEX "assistant_user_identities_app_idx" ON "assistant_user_identities" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "conversations_app_user_idx" ON "conversations" USING btree ("app_id","tenant_id","external_user_id");--> statement-breakpoint
CREATE INDEX "conversations_trace_idx" ON "conversations" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_trace_idx" ON "messages" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_conversation_idx" ON "tool_calls" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "tool_calls_trace_idx" ON "tool_calls" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "tool_calls_tool_idx" ON "tool_calls" USING btree ("tool_name","tool_version");--> statement-breakpoint
CREATE INDEX "tool_calls_status_idx" ON "tool_calls" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_definitions_name_version_idx" ON "tool_definitions" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "tool_definitions_enabled_idx" ON "tool_definitions" USING btree ("enabled");