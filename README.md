# Watchtower

A copilot for a solo community manager: it watches your product's community forum, finds past
threads that already solved the same problem, and drafts internal investigation notes and
customer-facing replies grounded in what actually worked before.

It does not post, reply, or submit anything on your behalf, every draft is reviewed and sent by
hand. Everything it reads from your community platform is a plain, read-only GET.

**Stack:** Next.js (App Router) · Supabase (Postgres + pgvector + Deno edge functions) · an
OpenAI-compatible chat/embedding API · Vercel.

## The problem it solves

Two posts describing the same bug rarely look alike. "it won't load" and "stuck at 99%" are the
same underlying issue written by two different people, often in different languages. The case
you're working is also almost always unanswered, the actual fix, if it exists, is on a
*different* thread that was already resolved. Watchtower's job is: given a new post, find the past
threads that solved the same problem, and tell you what to do.

## What it does

The dashboard has one input box and two actions:

- **Go**, drafts a customer-facing reply, grounded in your own verified answers, official support
  docs, and trusted staff replies, in that priority order. A citation that can't be verified
  against the real source text is shown as ungrounded rather than silently trusted.
- **Investigate**, an internal walkthrough for you, not the customer: what this case is, what to
  do in order, and which past case each step came from. It decides up front whether the case is
  answerable immediately or genuinely needs more information from the poster, so a one-line
  billing question never gets padded into a diagnostic checklist.

Retrieval works by embedding an abstracted, language-neutral description of the problem rather than
raw post text, so a Spanish billing question can surface an English answer that already solved it.

## Configuring it for your own community

This tool ships with no product or platform baked in, set these as environment variables (see
`.env.example`) before it's useful:

| Variable | What it configures |
|---|---|
| `COMMUNITY_HOST` | The community forum's host, e.g. `community.example.com`. Must run the inSided/Gainsight platform (sitemap + JSON-LD QAPage/DiscussionForumPosting pages), see `supabase/functions/_shared/community-sources.ts`. |
| `WATCHED_BOARDS` / `NEXT_PUBLIC_WATCHED_BOARDS` | Comma-separated board slugs to scope discovery to. Empty means every board the sitemap covers. |
| `SUPPORT_DOCS_HOST`, `SUPPORT_DOCS_PATH_PREFIX`, `SUPPORT_DOCS_SEED_URL` | Your product's official documentation site, for the highest-authority grounding tier. |
| `SUPPORT_DOCS_ADDITIONAL_SEEDS` | Extra doc-tree entry points (comma-separated URLs), for a doc tree deep enough that crawling from one seed misses pages. |
| `COMMUNITY_TAGS` / `NEXT_PUBLIC_COMMUNITY_TAGS` | JSON array of your platform's real tag taxonomy, so tag suggestions only ever return values that exist on the board. |
| `TRUSTED_AUTHORS`, `EXTRA_AUTHORITY_BADGES` | Named staff/experts and extra badge text your platform uses, so their replies are recognized as authoritative. |
| `PRODUCT_NAME` / `NEXT_PUBLIC_PRODUCT_NAME` | Your product's name, interpolated into the AI prompts and the topic graph's root label. |
| `TRUSTED_AUTHOR_PROFILE_URLS` | Profile URLs for the one-time trusted-reply backfill script (`scripts/scrape-trusted-replies.ts`). |

## Project layout

- `app/`, Next.js dashboard, library, replies, context and watches screens.
- `supabase/functions/`, Deno edge functions: drafting, investigation, tag/keyword suggestion,
  watch runs, support-doc crawling.
- `supabase/functions/_shared/`, the platform-integration layer (`community-sources.ts`,
  `support-docs.ts`) and grounding/investigation logic, isolated behind a small function surface so
  a different community platform only needs those two files' internals to change.
  Fetch/scrape modules are read-only toward the outside world by design: GET only, own User-Agent,
  never posts or writes anything to your community platform.
- `scripts/topic-taxonomy/`, a one-off (but periodically re-run) pipeline that builds a fixed
  Topic/Subtopic taxonomy from a corpus of scraped community posts, used for the solved-thread
  retrieval tier. See its own README for the run order.

## Local development

```
npm install
cp .env.example .env.local   # fill in your own values
npm run dev
```

Database schema lives in `supabase/migrations/`; apply with `supabase db push` against your linked
project.
