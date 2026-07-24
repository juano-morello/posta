CREATE TABLE "links" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" text NOT NULL,
	"destination" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "links_tenant_id_slug_key" UNIQUE("tenant_id","slug"),
	CONSTRAINT "links_destination_absolute_url_check" CHECK ("links"."destination" ~* '^https?://')
);
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "links_tenant_id_created_at_idx" ON "links" USING btree ("tenant_id","created_at" DESC NULLS LAST);