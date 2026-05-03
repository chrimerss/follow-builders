#!/usr/bin/env node

// ============================================================================
// Follow Builders — Deliver Feed from upstream centralized repo (no LLM)
// ============================================================================
// Fetches the committed feed JSON files from zarazhangrui/follow-builders
// and sends a formatted digest directly to Telegram.
//
// Required environment variables:
//   TELEGRAM_BOT_TOKEN    — Telegram bot token (from @BotFather)
//   TELEGRAM_CHAT_ID      — Telegram chat / channel ID
//
// Optional environment variables:
//   UPSTREAM_REPO         — GitHub "owner/repo" to pull feeds from
//                           (default: zarazhangrui/follow-builders)
//   UPSTREAM_BRANCH       — Branch to pull from (default: main)
//   MAX_TWEETS            — Max tweets to include (default: 20)
//   MAX_PODCASTS          — Max podcast episodes (default: 8)
//   MAX_BLOGS             — Max blog posts (default: 10)
// ============================================================================

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const UPSTREAM_REPO   = process.env.UPSTREAM_REPO   || 'zarazhangrui/follow-builders';
const UPSTREAM_BRANCH = process.env.UPSTREAM_BRANCH || 'main';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const MAX_TWEETS   = parseInt(process.env.MAX_TWEETS   || '', 10) || 20;
const MAX_PODCASTS = parseInt(process.env.MAX_PODCASTS || '', 10) || 8;
const MAX_BLOGS    = parseInt(process.env.MAX_BLOGS    || '', 10) || 10;

// ---------------------------------------------------------------------------
// Validate required environment variables
// ---------------------------------------------------------------------------

for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
  if (!process.env[key]) {
    console.error(`❌  Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Fetch a feed JSON file from the upstream repo via raw.githubusercontent.com
// ---------------------------------------------------------------------------

async function fetchFeed(filename) {
  const url = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/${filename}`;
  console.log(`⬇️   Fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`⚠️   Could not fetch ${filename}: HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Format the feeds into a Telegram-friendly message (no LLM)
// ---------------------------------------------------------------------------

function formatDigest(feedX, feedPodcasts, feedBlogs) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const lines = [];
  lines.push(`📰 *AI Builders Digest — ${today}*`);
  lines.push(`_Source: [${UPSTREAM_REPO}](https://github.com/${UPSTREAM_REPO})_`);
  lines.push('');

  // --- Tweets ---
  const tweets = feedX?.x?.flatMap(author =>
    (author.tweets || []).map(t => ({ handle: author.handle, text: t.text || t }))
  ) || [];

  if (tweets.length > 0) {
    lines.push('🐦 *From X / Twitter*');
    for (const t of tweets.slice(0, MAX_TWEETS)) {
      const snippet = t.text.length > 200 ? t.text.slice(0, 197) + '…' : t.text;
      lines.push(`• @${t.handle}: ${snippet}`);
    }
    lines.push('');
  }

  // --- Podcasts ---
  const podcasts = feedPodcasts?.podcasts || [];
  if (podcasts.length > 0) {
    lines.push('🎙️ *Podcast Episodes*');
    for (const p of podcasts.slice(0, MAX_PODCASTS)) {
      const show    = p.show || p.podcast || '';
      const summary = p.summary || p.description || '';
      const snippet = summary.length > 250 ? summary.slice(0, 247) + '…' : summary;
      lines.push(`• *${p.title}*${show ? ` (${show})` : ''}`);
      if (snippet) lines.push(`  ${snippet}`);
    }
    lines.push('');
  }

  // --- Blogs ---
  const blogs = feedBlogs?.blogs || [];
  if (blogs.length > 0) {
    lines.push('📝 *Blog Posts*');
    for (const b of blogs.slice(0, MAX_BLOGS)) {
      const author  = b.author || b.feed || '';
      const summary = b.summary || b.description || '';
      const snippet = summary.length > 250 ? summary.slice(0, 247) + '…' : summary;
      const urlPart = b.url ? ` — [link](${b.url})` : '';
      lines.push(`• *${b.title}*${author ? ` — ${author}` : ''}${urlPart}`);
      if (snippet) lines.push(`  ${snippet}`);
    }
    lines.push('');
  }

  if (tweets.length === 0 && podcasts.length === 0 && blogs.length === 0) {
    lines.push('_(No new content available today.)_');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Send to Telegram (with chunking and 500 ms delay between chunks)
// ---------------------------------------------------------------------------

async function sendTelegram(text) {
  const MAX_LEN = 4000;
  const chunks  = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    // Fall back to a hard cut if no suitable newline was found in the first half
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  console.log(`📨  Sending ${chunks.length} message chunk(s) to Telegram…`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If Markdown parsing fails, retry without parse_mode
      if (err.description && err.description.includes("can't parse")) {
        console.warn(`⚠️   Markdown parse error on chunk ${i + 1}, retrying without formatting…`);
        const retry = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: TELEGRAM_CHAT_ID,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
        if (!retry.ok) {
          const retryErr = await retry.json();
          throw new Error(`Telegram API error: ${retryErr.description}`);
        }
      } else {
        throw new Error(`Telegram API error: ${err.description}`);
      }
    }

    console.log(`✅  Chunk ${i + 1}/${chunks.length} sent.`);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`📡  Pulling feeds from ${UPSTREAM_REPO} (${UPSTREAM_BRANCH})…`);

  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchFeed('feed-x.json'),
    fetchFeed('feed-podcasts.json'),
    fetchFeed('feed-blogs.json')
  ]);

  const totalItems =
    (feedX?.x?.reduce((sum, a) => sum + (a.tweets?.length || 0), 0) || 0) +
    (feedPodcasts?.podcasts?.length || 0) +
    (feedBlogs?.blogs?.length       || 0);

  console.log(`📊  ${totalItems} feed item(s) found.`);

  const message = formatDigest(feedX, feedPodcasts, feedBlogs);
  await sendTelegram(message);

  console.log('🎉  Delivered successfully!');
}

main().catch(err => {
  console.error(`❌  Fatal: ${err.message}`);
  process.exit(1);
});
