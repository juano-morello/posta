CREATE TABLE "asn_datacenter" (
	"asn" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
