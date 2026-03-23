import type { CheerioAPI } from "cheerio";
import type { Rules, RulesOptions } from "metascraper";

import logger from "@karakeep/shared/logger";

const MAX_REPLIES = 20;

interface ExtractedTweet {
  authorName: string;
  authorHandle: string;
  timestamp: string;
  textHtml: string;
  images: string[];
  hasVideo: boolean;
  isMainTweet: boolean;
  tweetUrl: string | null;
}

/**
 * Extract the domain name without suffix from a URL.
 * e.g. "https://x.com/foo" -> "x"
 */
const domainFromUrl = (url: string): string => {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    return hostname;
  } catch (error) {
    logger.error(
      "[MetascraperTwitter] domainFromUrl received an invalid URL:",
      error,
    );
    return "";
  }
};

/**
 * Extract the tweet/status ID from a Twitter URL path.
 * e.g. "/username/status/1234567890" -> "1234567890"
 */
const extractTweetId = (url: string): string | undefined => {
  try {
    const parts = new URL(url).pathname.split("/");
    const statusIdx = parts.indexOf("status");
    if (statusIdx !== -1 && statusIdx + 1 < parts.length) {
      return parts[statusIdx + 1];
    }
  } catch {
    // ignore
  }
  return undefined;
};

/**
 * Extract data from a single tweet element.
 */
const extractSingleTweet = (
  el: ReturnType<CheerioAPI>,
  $: CheerioAPI,
  mainTweetId: string | undefined,
): ExtractedTweet | null => {
  // Extract tweet text
  const tweetTextEl = el.find('[data-testid="tweetText"]').first();
  const textHtml = tweetTextEl.html()?.trim() ?? "";

  // Extract author handle - look for links that match /@handle pattern
  let authorHandle = "";
  let authorName = "";

  // Find the user name section - typically the first group of links in the tweet header
  // The handle link points to /<username> and contains text starting with @
  el.find('a[role="link"]').each((_, linkEl) => {
    const href = $(linkEl).attr("href") ?? "";
    const text = $(linkEl).text().trim();
    if (!authorHandle && text.startsWith("@") && /^\/\w+$/.test(href)) {
      authorHandle = text;
    }
  });

  // Author name: look for links to the user profile that don't start with @
  if (authorHandle) {
    const handlePath = authorHandle.replace("@", "/");
    el.find(`a[role="link"][href="${handlePath}"]`).each((_, linkEl) => {
      const text = $(linkEl).text().trim();
      if (!authorName && text && !text.startsWith("@")) {
        authorName = text;
      }
    });
  }

  // Extract timestamp
  const timeEl = el.find("time").first();
  const timestamp = timeEl.attr("datetime") ?? "";

  // Extract images
  const images: string[] = [];
  el.find('[data-testid="tweetPhoto"] img').each((_, imgEl) => {
    const src = $(imgEl).attr("src");
    if (src) {
      images.push(src);
    }
  });

  // Check for video
  const hasVideo = el.find('[data-testid="videoPlayer"]').length > 0;

  // Determine if this is the main tweet by checking for a link containing the status ID
  let isMainTweet = false;
  let tweetUrl: string | null = null;
  if (mainTweetId) {
    el.find(`a[href*="/status/${mainTweetId}"]`).each((_, linkEl) => {
      const href = $(linkEl).attr("href") ?? "";
      if (href.includes(`/status/${mainTweetId}`)) {
        isMainTweet = true;
      }
    });
  }

  // Try to find a status link for this tweet (for non-main tweets)
  if (!isMainTweet) {
    el.find('a[href*="/status/"]').each((_, linkEl) => {
      const href = $(linkEl).attr("href") ?? "";
      // Match links like /username/status/12345 (with optional query params)
      if (!tweetUrl && /^\/\w+\/status\/\d+/.test(href)) {
        tweetUrl = `https://x.com${href}`;
      }
    });
  } else {
    tweetUrl = `https://x.com${authorHandle.replace("@", "/")}${mainTweetId ? `/status/${mainTweetId}` : ""}`;
  }

  // Skip tweets with no meaningful content
  if (!textHtml && images.length === 0 && !hasVideo) {
    return null;
  }

  return {
    authorName,
    authorHandle,
    timestamp,
    textHtml,
    images,
    hasVideo,
    isMainTweet,
    tweetUrl,
  };
};

/**
 * Format an ISO timestamp into a human-readable date string.
 */
const formatTimestamp = (iso: string): string => {
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

/**
 * Build HTML for a single tweet.
 */
const buildTweetHtml = (tweet: ExtractedTweet): string => {
  const parts: string[] = [];

  // Author header
  const authorParts: string[] = [];
  if (tweet.authorName) {
    authorParts.push(`<strong>${tweet.authorName}</strong>`);
  }
  if (tweet.authorHandle) {
    authorParts.push(tweet.authorHandle);
  }
  if (tweet.timestamp) {
    authorParts.push(formatTimestamp(tweet.timestamp));
  }
  if (authorParts.length > 0) {
    parts.push(`<p>${authorParts.join(" · ")}</p>`);
  }

  // Tweet text
  if (tweet.textHtml) {
    parts.push(`<div>${tweet.textHtml}</div>`);
  }

  // Images
  for (const src of tweet.images) {
    parts.push(`<img src="${src}" />`);
  }

  // Video placeholder
  if (tweet.hasVideo) {
    const link = tweet.tweetUrl ?? "#";
    parts.push(`<p><a href="${link}">[Video]</a></p>`);
  }

  return parts.join("\n");
};

/**
 * Full DOM-based extraction for authenticated sessions.
 * Extracts thread context, main tweet, and replies.
 */
const extractFromDom = ($: CheerioAPI, url: string): string | undefined => {
  const tweetId = extractTweetId(url);
  const tweetEls = $('[data-testid="tweet"]');

  if (tweetEls.length === 0) {
    return undefined;
  }

  const tweets: ExtractedTweet[] = [];
  tweetEls.each((_, el) => {
    const tweet = extractSingleTweet($(el), $, tweetId);
    if (tweet) {
      tweets.push(tweet);
    }
  });

  if (tweets.length === 0) {
    return undefined;
  }

  // If we couldn't identify the main tweet by ID, treat the first tweet as main
  const hasMain = tweets.some((t) => t.isMainTweet);
  if (!hasMain && tweets.length > 0) {
    tweets[0].isMainTweet = true;
  }

  // Classify: thread (before main), main, replies (after main)
  const mainIndex = tweets.findIndex((t) => t.isMainTweet);
  const threadTweets = tweets.slice(0, mainIndex);
  const mainTweet = tweets[mainIndex];
  const replyTweets = tweets.slice(mainIndex + 1, mainIndex + 1 + MAX_REPLIES);

  const htmlParts: string[] = [];

  // Thread context
  for (const tweet of threadTweets) {
    htmlParts.push(`<blockquote>${buildTweetHtml(tweet)}</blockquote>`);
  }

  if (threadTweets.length > 0) {
    htmlParts.push("<hr />");
  }

  // Main tweet
  if (mainTweet) {
    htmlParts.push(buildTweetHtml(mainTweet));
  }

  // Replies
  if (replyTweets.length > 0) {
    htmlParts.push("<hr />");
    htmlParts.push("<h3>Replies</h3>");
    for (const tweet of replyTweets) {
      htmlParts.push(`<blockquote>${buildTweetHtml(tweet)}</blockquote>`);
    }
  }

  return htmlParts.join("\n");
};

/**
 * Fallback extraction using og: meta tags when the DOM doesn't have
 * rendered tweet elements (unauthenticated / page didn't fully load).
 */
const extractFromMetaTags = (
  $: CheerioAPI,
  url: string,
): string | undefined => {
  const ogDescription =
    $('meta[property="og:description"]').attr("content")?.trim() ?? "";
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() ?? "";
  const ogImage = $('meta[property="og:image"]').attr("content")?.trim() ?? "";

  if (!ogDescription && !ogTitle) {
    return undefined;
  }

  const parts: string[] = [];

  // Parse author from og:title (format: "Author Name on X: \"tweet text\"")
  if (ogTitle) {
    const authorMatch = ogTitle.match(/^(.+?)\s+on X:/);
    if (authorMatch) {
      // Extract username from URL
      try {
        const username = new URL(url).pathname.split("/")[1];
        parts.push(
          `<p><strong>${authorMatch[1]}</strong>${username ? ` @${username}` : ""}</p>`,
        );
      } catch {
        parts.push(`<p><strong>${authorMatch[1]}</strong></p>`);
      }
    }
  }

  // Tweet text from description
  if (ogDescription) {
    parts.push(`<p>${ogDescription}</p>`);
  }

  // Image (skip the default X/Twitter OG image)
  if (ogImage && !ogImage.includes("/og/image.png")) {
    parts.push(`<img src="${ogImage}" />`);
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
};

const test = ({ url }: { url: string }): boolean => {
  const domain = domainFromUrl(url).toLowerCase();
  return domain === "twitter" || domain === "x";
};

const metascraperTwitter = () => {
  const rules: Rules = {
    pkgName: "metascraper-twitter",
    test,
    readableContentHtml: (({
      htmlDom,
      url,
    }: {
      htmlDom: CheerioAPI;
      url: string;
    }) => {
      // Try full DOM extraction first (authenticated path)
      const domContent = extractFromDom(htmlDom, url);
      if (domContent) {
        return domContent;
      }

      // Fallback to og: meta tags (unauthenticated path)
      const metaContent = extractFromMetaTags(htmlDom, url);
      if (metaContent) {
        return metaContent;
      }

      // Let Readability try as last resort
      return undefined;
    }) as unknown as RulesOptions,
  };

  return rules;
};

export default metascraperTwitter;
