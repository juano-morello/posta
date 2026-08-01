-- T4.1.1 — events_classified: the read-time verdict view [INV-5]. `events`
-- itself carries no classification column ([INV-4]: the worker enriches,
-- it never judges) and no ip column ([INV-6]) — this view is the ONLY
-- place a human/bot/unfurler/prefetch verdict is ever computed, and it is
-- computed fresh on every query, never stored. Query this view, never raw
-- `events`, for anything classification-shaped [INV-5]: improving a rule
-- is editing this file, and every row in history reclassifies with no
-- data rewrite.
--
-- Columns are enumerated by name below, NOT `e.*` — Postgres freezes a
-- `*` at CREATE VIEW time, so a later `ALTER TABLE events ADD COLUMN`
-- would silently not appear here. Enumerate every raw column, then append
-- `classification` and `why`.
--
-- RULE ORDER IS LOAD-BEARING (spec §7.1) — DO NOT REORDER. The two CASE
-- expressions below (`classification`, `why`) walk the EXACT SAME
-- predicates in the EXACT SAME order; they must never drift apart, or the
-- verdict and its stated reason stop matching each other. The two
-- reorderings that would silently inflate the human count if anyone
-- "cleans this up" later:
--   * Moving rule 1 (prefetch/preview) after rule 8 (else -> humano) —
--     rule 8 is a catch-all, so nothing placed after it can ever fire;
--     every prefetch would misclassify as humano.
--   * Moving rule 2 (the twelve known-unfurler user-agent tokens) after
--     rule 4 (the twelve self-declared-automation tokens) — none of the
--     unfurler tokens (facebookexternalhit, Twitterbot, WhatsApp,
--     TelegramBot, Slackbot, Discordbot, LinkedInBot, Applebot,
--     SkypeUriPreview, redditbot, Iframely, embedly) contain "bot",
--     "crawl", "spider", etc. except via their own already-matched
--     substrings — reordered, a UA like "WhatsApp/2.24" would fall all
--     the way through both rules and land on rule 8 as humano instead of
--     rule 2's unfurler.
--
-- Rules, in order (spec §7.1):
--   1. sec_purpose/purpose/x_purpose/x_moz declares prefetch or preview  -> prefetch
--   2. user_agent matches a known unfurler token                        -> unfurler
--   3. http_method = 'HEAD'                                             -> unfurler
--   4. user_agent self-declares automation (bot/crawl/curl/...)         -> bot
--   5. user_agent IS NULL OR ''                                         -> bot
--   6. known-datacenter ASN (asn_datacenter join) with no client hints  -> bot
--   7. no accept-language, no fetch metadata, no client hints           -> bot
--   8. else                                                             -> humano
CREATE VIEW events_classified AS
SELECT
  e.event_id,
  e.occurred_at,
  e.tenant_id,
  e.link_id,
  e.slug,
  e.visitor_hash,
  e.http_method,
  e.user_agent,
  e.referer,
  e.accept,
  e.accept_language,
  e.sec_fetch_site,
  e.sec_fetch_mode,
  e.sec_fetch_dest,
  e.sec_fetch_user,
  e.sec_purpose,
  e.sec_ch_ua,
  e.sec_ch_ua_mobile,
  e.sec_ch_ua_platform,
  e.purpose,
  e.x_purpose,
  e.x_moz,
  e.country,
  e.asn,
  e.browser,
  e.browser_version,
  e.os,
  e.device_type,
  e.source_platform,
  e.is_in_app,
  e.dest_host,
  CASE
    -- 1. prefetch/preview signal
    WHEN e.sec_purpose ILIKE '%prefetch%' OR e.sec_purpose ILIKE '%preview%'
      OR e.purpose ILIKE '%prefetch%' OR e.purpose ILIKE '%preview%'
      OR e.x_purpose ILIKE '%prefetch%' OR e.x_purpose ILIKE '%preview%'
      OR e.x_moz ILIKE '%prefetch%' OR e.x_moz ILIKE '%preview%'
      THEN 'prefetch'
    -- 2. known unfurler tokens — MUST stay before rule 4's generic tokens
    WHEN e.user_agent ILIKE '%facebookexternalhit%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%twitterbot%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%whatsapp%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%telegrambot%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%slackbot%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%discordbot%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%linkedinbot%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%applebot%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%skypeuripreview%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%redditbot%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%iframely%' THEN 'unfurler'
    WHEN e.user_agent ILIKE '%embedly%' THEN 'unfurler'
    -- 3. HEAD request (unfurlers frequently HEAD before rendering a card)
    WHEN e.http_method = 'HEAD' THEN 'unfurler'
    -- 4. self-declared automation tokens
    WHEN e.user_agent ILIKE '%bot%' THEN 'bot'
    WHEN e.user_agent ILIKE '%crawl%' THEN 'bot'
    WHEN e.user_agent ILIKE '%spider%' THEN 'bot'
    WHEN e.user_agent ILIKE '%curl%' THEN 'bot'
    WHEN e.user_agent ILIKE '%wget%' THEN 'bot'
    WHEN e.user_agent ILIKE '%python-requests%' THEN 'bot'
    WHEN e.user_agent ILIKE '%go-http-client%' THEN 'bot'
    WHEN e.user_agent ILIKE '%okhttp%' THEN 'bot'
    WHEN e.user_agent ILIKE '%axios%' THEN 'bot'
    WHEN e.user_agent ILIKE '%headlesschrome%' THEN 'bot'
    WHEN e.user_agent ILIKE '%puppeteer%' THEN 'bot'
    WHEN e.user_agent ILIKE '%playwright%' THEN 'bot'
    -- 5. no user-agent at all
    WHEN e.user_agent IS NULL OR e.user_agent = '' THEN 'bot'
    -- 6. known-datacenter ASN, no client hints to prove a real browser
    WHEN d.asn IS NOT NULL AND e.sec_ch_ua IS NULL THEN 'bot'
    -- 7. no accept-language, no fetch metadata, no client hints at all
    WHEN e.accept_language IS NULL AND e.sec_fetch_site IS NULL AND e.sec_ch_ua IS NULL THEN 'bot'
    -- 8. else
    ELSE 'humano'
  END AS classification,
  CASE
    -- 1. prefetch/preview signal — canonical literal regardless of which
    -- of the four columns actually fired
    WHEN e.sec_purpose ILIKE '%prefetch%' OR e.sec_purpose ILIKE '%preview%'
      OR e.purpose ILIKE '%prefetch%' OR e.purpose ILIKE '%preview%'
      OR e.x_purpose ILIKE '%prefetch%' OR e.x_purpose ILIKE '%preview%'
      OR e.x_moz ILIKE '%prefetch%' OR e.x_moz ILIKE '%preview%'
      THEN 'preview de link · Purpose: prefetch'
    -- 2. known unfurler tokens
    WHEN e.user_agent ILIKE '%facebookexternalhit%' THEN 'user-agent ''facebookexternalhit'''
    WHEN e.user_agent ILIKE '%twitterbot%' THEN 'user-agent ''Twitterbot'''
    WHEN e.user_agent ILIKE '%whatsapp%' THEN 'user-agent ''WhatsApp'''
    WHEN e.user_agent ILIKE '%telegrambot%' THEN 'user-agent ''TelegramBot'''
    WHEN e.user_agent ILIKE '%slackbot%' THEN 'user-agent ''Slackbot'''
    WHEN e.user_agent ILIKE '%discordbot%' THEN 'user-agent ''Discordbot'''
    WHEN e.user_agent ILIKE '%linkedinbot%' THEN 'user-agent ''LinkedInBot'''
    WHEN e.user_agent ILIKE '%applebot%' THEN 'user-agent ''Applebot'''
    WHEN e.user_agent ILIKE '%skypeuripreview%' THEN 'user-agent ''SkypeUriPreview'''
    WHEN e.user_agent ILIKE '%redditbot%' THEN 'user-agent ''redditbot'''
    WHEN e.user_agent ILIKE '%iframely%' THEN 'user-agent ''Iframely'''
    WHEN e.user_agent ILIKE '%embedly%' THEN 'user-agent ''embedly'''
    -- 3. HEAD request
    WHEN e.http_method = 'HEAD' THEN 'método HEAD'
    -- 4. self-declared automation tokens
    WHEN e.user_agent ILIKE '%bot%' THEN 'user-agent ''bot'''
    WHEN e.user_agent ILIKE '%crawl%' THEN 'user-agent ''crawl'''
    WHEN e.user_agent ILIKE '%spider%' THEN 'user-agent ''spider'''
    WHEN e.user_agent ILIKE '%curl%' THEN 'user-agent ''curl'''
    WHEN e.user_agent ILIKE '%wget%' THEN 'user-agent ''wget'''
    WHEN e.user_agent ILIKE '%python-requests%' THEN 'user-agent ''python-requests'''
    WHEN e.user_agent ILIKE '%go-http-client%' THEN 'user-agent ''go-http-client'''
    WHEN e.user_agent ILIKE '%okhttp%' THEN 'user-agent ''okhttp'''
    WHEN e.user_agent ILIKE '%axios%' THEN 'user-agent ''axios'''
    WHEN e.user_agent ILIKE '%headlesschrome%' THEN 'user-agent ''headlesschrome'''
    WHEN e.user_agent ILIKE '%puppeteer%' THEN 'user-agent ''puppeteer'''
    WHEN e.user_agent ILIKE '%playwright%' THEN 'user-agent ''playwright'''
    -- 5. no user-agent at all
    WHEN e.user_agent IS NULL OR e.user_agent = '' THEN 'sin user-agent'
    -- 6. known-datacenter ASN, no client hints
    WHEN d.asn IS NOT NULL AND e.sec_ch_ua IS NULL
      THEN 'ASN ' || d.asn::text || ' (' || d.name || ') sin fingerprint de browser'
    -- 7. no accept-language, no fetch metadata, no client hints at all
    WHEN e.accept_language IS NULL AND e.sec_fetch_site IS NULL AND e.sec_ch_ua IS NULL
      THEN 'sin accept-language ni fetch metadata'
    -- 8. else
    ELSE 'humano'
  END AS why
FROM events e
LEFT JOIN asn_datacenter d ON d.asn = e.asn;
