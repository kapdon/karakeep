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

  // Author header with link to tweet (timestamp links to the tweet URL, matching Twitter's pattern)
  const authorParts: string[] = [];
  if (tweet.authorName) {
    authorParts.push(`<strong>${tweet.authorName}</strong>`);
  }
  if (tweet.authorHandle) {
    authorParts.push(tweet.authorHandle);
  }
  if (tweet.timestamp) {
    const formatted = formatTimestamp(tweet.timestamp);
    if (tweet.tweetUrl) {
      authorParts.push(`<a href="${tweet.tweetUrl}">${formatted}</a>`);
    } else {
      authorParts.push(formatted);
    }
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
 * Check if a URL is an X article page.
 */
const isArticleUrl = (url: string): boolean => {
  try {
    return /\/[\w]+\/article\/\d+/.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/**
 * Extract content from an X article page.
 * X articles use a Draft.js-based rich text editor with specific data-testid attributes:
 * - [data-testid="twitter-article-title"] — article title
 * - [data-testid="twitterArticleRichTextView"] — article container
 * - [data-testid="longformRichTextComponent"] — rich text body
 * - [data-block="true"] — individual text blocks within the rich text
 * - [data-testid="tweetPhoto"] img — embedded images (interleaved with text)
 * - [data-testid="tweet"] — embedded tweets (interleaved with text)
 *
 * Content elements are interleaved in the DOM — we walk them in order
 * to preserve the article's reading flow.
 */
const extractArticleFromDom = (
  $: CheerioAPI,
  _url: string,
): string | undefined => {
  const parts: string[] = [];

  // Extract title
  const titleEl = $('[data-testid="twitter-article-title"]');
  if (titleEl.length > 0) {
    const titleText = titleEl.text().trim();
    if (titleText) {
      parts.push(`<h1>${titleText}</h1>`);
    }
  }

  // Banner image — the first tweetPhoto on the page (before the rich text view)
  const firstPhoto = $('[data-testid="tweetPhoto"] img').first();
  if (firstPhoto.length > 0) {
    const src = firstPhoto.attr("src");
    if (src) {
      parts.push(`<img src="${src}" />`);
    }
  }

  // Walk all descendants of the rich text view in DOM order.
  // Track seen elements to avoid duplicates from nested matches.
  const richView = $('[data-testid="twitterArticleRichTextView"]');
  if (richView.length === 0) {
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  const seen = new Set<object>();

  richView.find("*").each((_, el) => {
    if (seen.has(el)) return;

    const testId = $(el).attr("data-testid") ?? "";
    const isBlock = $(el).attr("data-block") === "true";

    if (isBlock) {
      seen.add(el);
      // Skip text blocks that are inside or contain embedded tweets —
      // those are handled by the tweet extraction below.
      if (
        $(el).closest('[data-testid="tweet"]').length > 0 ||
        $(el).closest('[data-testid="simpleTweet"]').length > 0 ||
        $(el).find('[data-testid="tweet"]').length > 0 ||
        $(el).find('[data-testid="simpleTweet"]').length > 0
      ) {
        return;
      }
      // Preserve links by extracting text and <a> tags from the block.
      // Draft.js wraps content in nested spans — we walk leaf nodes only,
      // skipping spans that are inside <a> tags (the <a> itself handles those).
      const blockParts: string[] = [];
      $(el)
        .find("span, a")
        .each((_, child) => {
          if ($(child).is("a")) {
            const href = $(child).attr("href") ?? "";
            const linkText = $(child).text().trim();
            if (href && linkText) {
              blockParts.push(`<a href="${href}">${linkText}</a>`);
            }
          } else if ($(child).is("span")) {
            // Skip spans inside <a> tags — already handled above
            if ($(child).closest("a").length > 0) return;
            // Only emit leaf spans (no child spans or anchors)
            if (
              $(child).children("a").length === 0 &&
              $(child).children("span").length === 0
            ) {
              const text = $(child).text();
              if (text) {
                blockParts.push(text);
              }
            }
          }
        });
      const blockHtml = blockParts.join("").trim();
      if (blockHtml) {
        parts.push(`<p>${blockHtml}</p>`);
      }
    } else if (testId === "tweetPhoto") {
      seen.add(el);
      // Skip photos inside embedded tweets
      if (
        $(el).closest('[data-testid="tweet"]').length > 0 ||
        $(el).closest('[data-testid="simpleTweet"]').length > 0
      ) {
        return;
      }
      // Skip the banner image we already extracted
      const img = $(el).find("img").first();
      const src = img.attr("src") ?? "";
      if (src && src !== firstPhoto.attr("src")) {
        parts.push(`<img src="${src}" />`);
      }
    } else if (testId === "tweet" || testId === "simpleTweet") {
      seen.add(el);
      // Mark all descendants as seen so they don't get processed individually
      $(el)
        .find("*")
        .each((_, descendant) => {
          seen.add(descendant);
        });
      // Extract embedded tweet — get all tweetText elements (first is the main
      // tweet, second is a quote tweet if present) and a link to the original.
      const tweetTexts = $(el).find('[data-testid="tweetText"]');
      const statusLink = $(el).find('a[href*="/status/"]').first();
      const href = statusLink.attr("href") ?? "";
      const tweetUrl = href ? `https://x.com${href.split("?")[0]}` : "";

      const mainText = tweetTexts.eq(0).text().trim();
      const quoteText =
        tweetTexts.length > 1 ? tweetTexts.eq(1).text().trim() : "";

      if (mainText || tweetUrl) {
        const contentParts: string[] = [];
        if (mainText) {
          contentParts.push(`<p>${mainText}</p>`);
        }
        if (quoteText) {
          contentParts.push(`<blockquote><p>${quoteText}</p></blockquote>`);
        }
        if (tweetUrl) {
          contentParts.push(`<p><a href="${tweetUrl}">${tweetUrl}</a></p>`);
        }
        parts.push(`<blockquote>${contentParts.join("\n")}</blockquote>`);
      }
    }
  });

  // Extract replies section — injected by the crawler from the original tweet
  // page before navigating to the article. Format: <h3>Replies</h3> followed
  // by <blockquote> elements containing reply text and tweet status links.
  const repliesHeader = $("h3").filter((_, el) => $(el).text() === "Replies");
  if (repliesHeader.length > 0) {
    parts.push("<hr />");
    parts.push("<h3>Replies</h3>");
    // Collect all blockquotes that follow the Replies header
    let next = repliesHeader.first().next();
    while (next.length > 0 && next.is("blockquote")) {
      const html = next.html()?.trim();
      if (html) {
        parts.push(`<blockquote>${html}</blockquote>`);
      }
      next = next.next();
    }
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
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
    title: (({ htmlDom, url }: { htmlDom: CheerioAPI; url: string }) => {
      if (!isArticleUrl(url)) return undefined;
      const titleEl = htmlDom('[data-testid="twitter-article-title"]');
      return titleEl.text().trim() || undefined;
    }) as unknown as RulesOptions,
    author: (({ htmlDom, url }: { htmlDom: CheerioAPI; url: string }) => {
      if (!isArticleUrl(url)) return undefined;
      // Extract author from UserAvatar-Container that's NOT inside an embedded tweet.
      // The testid format is UserAvatar-Container-{username}.
      let authorUsername: string | undefined;
      htmlDom('[data-testid^="UserAvatar-Container-"]').each((_, el) => {
        if (authorUsername) return;
        // Skip avatars inside embedded tweets
        if (htmlDom(el).closest('[data-testid="tweet"]').length > 0) return;
        if (htmlDom(el).closest('[data-testid="simpleTweet"]').length > 0)
          return;
        const testId = htmlDom(el).attr("data-testid") ?? "";
        const match = testId.match(/^UserAvatar-Container-(.+)$/);
        if (match) {
          authorUsername = match[1];
        }
      });
      return authorUsername ?? undefined;
    }) as unknown as RulesOptions,
    readableContentHtml: (({
      htmlDom,
      url,
    }: {
      htmlDom: CheerioAPI;
      url: string;
    }) => {
      // Handle X article pages (x.com/i/article/*)
      if (isArticleUrl(url)) {
        const articleContent = extractArticleFromDom(htmlDom, url);
        if (articleContent) {
          return articleContent;
        }
        // Fall through to other extraction methods
      }

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
