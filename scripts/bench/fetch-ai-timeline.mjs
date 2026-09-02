#!/usr/bin/env node
// This fetches the "AI company timeline" corpus: Wikipedia article text, converted to
// the bench corpus format.
//
// Why this corpus instead of State of the Union speeches: an earlier measurement of
// the State of the Union corpus found that only 33 of 758 facts carried a date (4.4%),
// and only 2 facts had a supersedes relation. Political speech **asserts**; it does
// not **record**, so most of its sentences carry no date. Every article chosen here,
// by contrast, has facts shaped like "on this date, X did Y".
//
// More important, **the same predicate changes value here.** OpenAI's CEO changed four
// times in the six days from 2023-11-17 to 2023-11-22 (Altman, then Murati, then
// Shear, then Altman again). This is exactly what bitemporal modeling needs to show:
// not "the knowledge base has a time field", but "we believed three different answers
// to the same question, one after another, and the system keeps all three".
//
// License: Wikipedia article text is CC BY-SA 4.0. It can be redistributed, but
// **redistribution requires attribution and share-alike terms.** This differs from the
// public-domain State of the Union corpus. The corpus file records its license
// separately; do not treat it as the repository's main license.
//
// Usage: node scripts/bench/fetch-ai-timeline.mjs > scripts/bench/corpora/ai-timeline.json

import { execFileSync } from "node:child_process";

const UA = "Utopia-bench/0.1 (+https://utopia.bi; corpus builder)";

// **This uses curl, not fetch.** On this machine, HTTP_PROXY and HTTPS_PROXY point to
// a local proxy. Node 20's undici does not read those two environment variables
// (NODE_USE_ENV_PROXY was added only in Node 24), so every fetch call failed with
// UND_ERR_CONNECT_TIMEOUT, while curl returned 200 for the same address. This script
// runs once to build a corpus, so adding an undici ProxyAgent dependency for it is not
// worth the cost.
const curl = (url) =>
  execFileSync("curl", ["-sSL", "--compressed", "--max-time", "60", "-A", UA, url], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

// This list has three groups, each covering one part of the demo.
const TITLES = [
  // Group 1: changing understanding. One predicate, six days, four values. This is the
  // centerpiece of the whole corpus.
  "Removal of Sam Altman from OpenAI",
  // Group 2: organizations. Founding date, funding rounds, valuation, and leadership,
  // all dated and all subject to change.
  "OpenAI",
  "Anthropic",
  "DeepMind",
  "Mistral AI",
  "Hugging Face",
  "Stability AI",
  "Inflection AI",
  "Safe Superintelligence",
  "XAI (company)",
  // Group 3: products. Each version supersedes the last, forming a natural
  // valid_from/valid_to chain.
  "GPT-4",
  "ChatGPT",
  "Claude (language model)",
  "Gemini (language model)",
  "Llama (language model)",
];

function extract(title) {
  const u = new URL("https://en.wikipedia.org/w/api.php");
  u.searchParams.set("action", "query");
  u.searchParams.set("prop", "extracts");
  u.searchParams.set("explaintext", "1");
  u.searchParams.set("redirects", "1");
  u.searchParams.set("format", "json");
  u.searchParams.set("formatversion", "2");
  u.searchParams.set("titles", title);
  const page = JSON.parse(curl(u.toString())).query.pages[0];
  if (page.missing) throw new Error(`${title}: article does not exist`);
  return { title: page.title, text: page.extract || "" };
}

// The References, External links, and See also sections at the end are link and
// template leftovers. The extractor would treat them as body text and produce a set
// of disconnected, relationless entities. This cuts them out.
const CUT = /\n==+ ?(References|External links|See also|Further reading|Notes|Bibliography|Sources) ?==+/i;
const clean = (t) => t.split(CUT)[0].replace(/\n{3,}/g, "\n\n").trim();

const docs = [];
for (const title of TITLES) {
  try {
    const { title: real, text } = extract(title);
    const body = clean(text);
    const slug = real.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    docs.push([`${slug}.txt`, `${real}\n\n${body}\n`]);
    process.stderr.write(`OK  ${real.padEnd(38)} ${String(body.length).padStart(7)} characters\n`);
  } catch (e) {
    process.stderr.write(`ERR ${title}: ${e.message}\n`);
  }
}

const total = docs.reduce((n, [, t]) => n + t.length, 0);
process.stderr.write(`\n${docs.length} articles, ${total.toLocaleString()} characters total, about ${Math.round(total / 950)} chunks\n`);

process.stdout.write(JSON.stringify({
  name: "ai-timeline",
  note: "The AI company timeline. This corpus was chosen because a measurement of the State of the Union corpus found almost no dated facts (only 33 of 758 facts carried a valid_from date, and only 2 had a supersedes relation) -- political speech asserts, it does not record. Every sentence in this corpus carries a date, and the same predicate changes value: OpenAI's CEO changed four times between 2023-11-17 and 2023-11-22, which is the clearest example of bitemporal modeling available. The References and External links sections have been cut, because they are link leftovers that would only produce disconnected entities. Note: these companies are very common in model training data, which makes this corpus good for a demo (a familiar result reads as a strength) but not suitable as an accuracy benchmark (a familiar result may just be recall from training, not extraction).",
  source: "https://en.wikipedia.org/ -- MediaWiki action=query&prop=extracts",
  license: "CC BY-SA 4.0 (attribution and share-alike; differs from the repository's main license)",
  docs,
}, null, 1));
