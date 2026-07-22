CREATE TABLE "bio_links" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bio_page_id" text NOT NULL,
	"link_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bio_links_bio_page_id_position_key" UNIQUE("bio_page_id","position")
);
--> statement-breakpoint
ALTER TABLE "bio_links" ADD CONSTRAINT "bio_links_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bio_links" ADD CONSTRAINT "bio_links_bio_page_id_bio_pages_id_fk" FOREIGN KEY ("bio_page_id") REFERENCES "public"."bio_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bio_links" ADD CONSTRAINT "bio_links_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE restrict ON UPDATE no action;