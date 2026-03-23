import { JSDOM } from "jsdom";

const MAX_ARTICLE_REPLIES = 20;

export interface XArticleReply {
  author: string;
  handle: string;
  text: string;
  statusUrl: string;
}

export function extractXStatusId(url: string): string | null {
  try {
    const pathname = new URL(url, "https://x.com").pathname;
    return pathname.match(/\/status\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeXArticleUrl(href: string): string | null {
  try {
    const resolved = new URL(href, "https://x.com");
    const hostname = resolved.hostname.replace(/^www\./, "");

    if (hostname !== "x.com" && hostname !== "twitter.com") {
      return null;
    }

    const pathname = resolved.pathname.replace(/\/+$/, "");
    if (!/^\/(?:i\/article\/\d+|[\w]+\/article\/\d+)$/.test(pathname)) {
      return null;
    }

    return `https://x.com${pathname}`;
  } catch {
    return null;
  }
}

function getTopLevelTweets(document: Document): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="tweet"]'),
  ).filter((tweet) => !tweet.parentElement?.closest('[data-testid="tweet"]'));
}

function tweetContainsStatusId(tweet: HTMLElement, statusId: string): boolean {
  return Array.from(tweet.querySelectorAll<HTMLAnchorElement>("a[href]")).some(
    (link) => extractXStatusId(link.getAttribute("href") ?? "") === statusId,
  );
}

function extractAuthorMetadata(tweet: HTMLElement): {
  author: string;
  handle: string;
} {
  let handle = "";
  let author = "";

  const links = tweet.querySelectorAll<HTMLAnchorElement>('a[role="link"]');
  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    const linkText = link.textContent?.trim() ?? "";

    if (!handle && linkText.startsWith("@") && /^\/\w+$/.test(href)) {
      handle = linkText;
      continue;
    }

    if (!author && !linkText.startsWith("@") && /^\/\w+$/.test(href)) {
      author = linkText;
    }
  }

  return { author, handle };
}

function extractStatusUrl(tweet: HTMLElement): string {
  const statusLink = Array.from(
    tweet.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'),
  ).find((link) => {
    const href = link.getAttribute("href") ?? "";
    return extractXStatusId(href) !== null;
  });

  const href = statusLink?.getAttribute("href");
  if (!href) {
    return "";
  }

  try {
    const resolved = new URL(href, "https://x.com");
    return `https://x.com${resolved.pathname}`;
  } catch {
    return "";
  }
}

export function extractXArticleUrlFromStatusHtml(
  html: string,
  pageUrl: string,
): string | null {
  const statusId = extractXStatusId(pageUrl);
  if (!statusId) {
    return null;
  }

  const document = new JSDOM(html).window.document;
  const mainTweet = getTopLevelTweets(document).find((tweet) =>
    tweetContainsStatusId(tweet, statusId),
  );

  if (!mainTweet) {
    return null;
  }

  for (const link of mainTweet.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href");
    if (!href) {
      continue;
    }

    const articleUrl = normalizeXArticleUrl(href);
    if (articleUrl) {
      return articleUrl;
    }
  }

  return null;
}

export function extractXArticleRepliesFromStatusHtml(
  html: string,
  pageUrl: string,
): XArticleReply[] | null {
  const statusId = extractXStatusId(pageUrl);
  if (!statusId) {
    return null;
  }

  const document = new JSDOM(html).window.document;
  const tweets = getTopLevelTweets(document);
  const mainTweetIndex = tweets.findIndex((tweet) =>
    tweetContainsStatusId(tweet, statusId),
  );

  if (mainTweetIndex === -1) {
    return null;
  }

  const replies = tweets
    .slice(mainTweetIndex + 1, mainTweetIndex + 1 + MAX_ARTICLE_REPLIES)
    .map((tweet) => {
      const { author, handle } = extractAuthorMetadata(tweet);
      const text =
        tweet.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ??
        "";
      const statusUrl = extractStatusUrl(tweet);

      return { author, handle, text, statusUrl };
    })
    .filter((reply) => reply.text || reply.statusUrl);

  return replies.length > 0 ? replies : null;
}
