CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"host" text NOT NULL,
	"type" text DEFAULT 'subdomain' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_host_unique" UNIQUE("host"),
	CONSTRAINT "domains_type_check" CHECK ("domains"."type" IN ('subdomain', 'custom'))
);
--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;