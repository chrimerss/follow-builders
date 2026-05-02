#!/usr/bin/env node

// ============================================================================
// Follow Builders — Generate Digest
// ============================================================================
// Reads the local feed JSON files, calls OpenAI to produce a digest, and
// sends the result to Telegram.
//
// Required environment variables:
//   OPENAI_API_KEY        — OpenAI API key
//   TELEGRAM_BOT_TOKEN    — Telegram bot token (from @BotFather)
//   TELEGRAM_CHAT_ID      — Telegram chat / channel ID
//
// Optional environment variables:
//   OPENAI_MODEL          — Model to use (default: gpt-4o)
//   DIGEST_LANGUAGE       — Language for the digest (default: English)
// ============================================================================

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

// ---------------------------------------------------------------------------
// Resolve repo root (one level up from scripts/)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Validate required environment variables
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌  Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o';
const DIGEST_LANGUAGE   = process.env.DIGEST_LANGUAGE || 'English';

// ---------------------------------------------------------------------------
// Read feed files
// ---------------------------------------------------------------------------

async function readFeed(filename) {
  const path = join(REPO_ROOT, filename);
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`⚠️   Could not read ${filename}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build OpenAI prompt
// ---------------------------------------------------------------------------

function buildPrompt(feedX, feedPodcasts, feedBlogs, language) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const sections = [];

  if (feedX?.x?.length) {
    const tweetLines = feedX.x.flatMap(author =>
      (author.tweets || []).map(t => `- @${author.handle}: ${t.text || t}`)
    );
    sections.push(`## Tweets / X Posts\n${tweetLines.slice(0, 30).join('\n')}`);
  }

  if (feedPodcasts?.podcasts?.length) {
    const podLines = feedPodcasts.podcasts.map(p =>
      `- **${p.title}** (${p.show || p.podcast || ''}): ${p.summary || p.description || ''}`
    );
    sections.push(`## Podcast Episodes\n${podLines.slice(0, 10).join('\n')}`);
  }

  if (feedBlogs?.blogs?.length) {
    const blogLines = feedBlogs.blogs.map(b =>
      `- **${b.title}** — ${b.author || b.feed || ''}: ${b.summary || b.description || b.url || ''}`
    );
    sections.push(`## Blog Posts\n${blogLines.slice(0, 15).join('\n')}`);
  }

  if (sections.length === 0) {
    sections.push('(No feed content available today.)');
  }

  return [
    `You are an AI assistant that writes concise, engaging daily digests for builders and developers.`,
    `Today is ${today}.`,
    `Write a digest in **${language}** summarising the following content from tweets, podcasts, and blog posts.`,
    `Keep it friendly and informative. Use markdown formatting suitable for Telegram.`,
    `Group by category, highlight the most interesting items, and end with 1-2 sentences of overall takeaway.`,
    ``,
    `--- CONTENT ---`,
    ...sections
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Call OpenAI Chat Completions API
// ---------------------------------------------------------------------------

async function generateDigest(prompt) {
  console.log(`🤖  Calling OpenAI (${OPENAI_MODEL})…`);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned an empty response');
  return text;
}

// ---------------------------------------------------------------------------
// Send to Telegram (with chunking and 500 ms delay between chunks)
// ---------------------------------------------------------------------------

async function sendTelegram(text) {
  const MAX_LEN = 4096;
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Prefer splitting at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    // Fall back to a hard cut if no suitable newline was found
    if (splitAt <= 0 || splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
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

    // Wait 500 ms between chunks to avoid rate limiting
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('📰  Reading feed files…');
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    readFeed('feed-x.json'),
    readFeed('feed-podcasts.json'),
    readFeed('feed-blogs.json')
  ]);

  const totalItems =
    (feedX?.x?.reduce((sum, a) => sum + (a.tweets?.length || 0), 0) || 0) +
    (feedPodcasts?.podcasts?.length || 0) +
    (feedBlogs?.blogs?.length || 0);

  console.log(`📊  Found ${totalItems} feed item(s) across all sources.`);

  const prompt = buildPrompt(feedX, feedPodcasts, feedBlogs, DIGEST_LANGUAGE);
  const digest = await generateDigest(prompt);

  console.log(`📝  Digest generated (${digest.length} chars).`);

  await sendTelegram(digest);

  console.log('🎉  Digest delivered successfully!');
}

main().catch(err => {
  console.error(`❌  Fatal error: ${err.message}`);
  process.exit(1);
});
