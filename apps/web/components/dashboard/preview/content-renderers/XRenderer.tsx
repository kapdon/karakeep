import { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import {
  enrichTweet,
  TweetActions,
  TweetContainer,
  TweetHeader,
  TweetInfo,
  TweetNotFound,
  TweetSkeleton,
  Tweet,
  useTweet,
} from "react-tweet";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";
import { BookmarkTypes, ZBookmark } from "@karakeep/shared/types/bookmarks";

import { ContentRenderer } from "./types";

function extractTweetId(url: string): string | null {
  const patterns = [
    /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/,
    /(?:twitter\.com|x\.com)\/i\/web\/status\/(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extract reply tweet IDs from the cached HTML content.
 */
function extractReplyTweetIds(html: string): string[] {
  const repliesIdx = html.indexOf("<h3>Replies</h3>");
  if (repliesIdx === -1) {
    return [];
  }
  const repliesSection = html.slice(repliesIdx);
  const ids: string[] = [];
  const linkPattern =
    /href="https?:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)"/g;
  let match;
  while ((match = linkPattern.exec(repliesSection)) !== null) {
    if (!ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }
  return ids;
}

/** Check if the extracted HTML is an article (has <h1> title). */
function isArticleContent(html: string): boolean {
  return html.includes("<h1>");
}

/**
 * Parse article HTML into an ordered list of content segments.
 * Each segment is either a raw HTML block or an embedded tweet ID.
 */
interface HtmlSegment {
  type: "html";
  content: string;
}
interface TweetSegment {
  type: "tweet";
  id: string;
}
type ArticleSegment = HtmlSegment | TweetSegment;

function parseArticleSegments(html: string): ArticleSegment[] {
  // Only parse up to the Replies section — replies are handled separately
  // by extractReplyTweetIds and rendered as individual <Tweet> cards.
  const repliesIdx = html.indexOf("<h3>Replies</h3>");
  const articleHtml = repliesIdx !== -1 ? html.slice(0, repliesIdx) : html;

  const segments: ArticleSegment[] = [];
  // Split on blockquotes that contain tweet status links
  // Pattern: <blockquote>...<a href="https://x.com/.../status/ID">...</a>...</blockquote>
  const blockquotePattern = /<blockquote>([\s\S]*?)<\/blockquote>/g;
  let lastIndex = 0;
  let match;

  while ((match = blockquotePattern.exec(articleHtml)) !== null) {
    // Add HTML before this blockquote
    if (match.index > lastIndex) {
      const before = articleHtml.slice(lastIndex, match.index).trim();
      if (before) {
        segments.push({ type: "html", content: before });
      }
    }

    // Check if this blockquote contains a tweet status link
    const blockContent = match[1];
    const tweetIdMatch = blockContent.match(
      /href="https?:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)"/,
    );

    if (tweetIdMatch) {
      // This is an embedded tweet — render natively
      segments.push({ type: "tweet", id: tweetIdMatch[1] });
    } else {
      // Regular blockquote — keep as HTML
      segments.push({ type: "html", content: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining HTML after last blockquote
  if (lastIndex < articleHtml.length) {
    const remaining = articleHtml.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ type: "html", content: remaining });
    }
  }

  return segments;
}

/**
 * Custom article tweet — shows the tweet header/actions from react-tweet
 * but replaces the body with extracted article content, including native
 * <Tweet> embeds for quoted tweets.
 */
function ArticleTweetEmbed({
  tweetId,
  segments,
}: {
  tweetId: string;
  segments: ArticleSegment[];
}) {
  const { data, error, isLoading } = useTweet(tweetId);

  if (isLoading) return <TweetSkeleton />;
  if (error || !data) return <TweetNotFound error={error} />;

  const tweet = enrichTweet(data);

  return (
    <TweetContainer>
      <TweetHeader tweet={tweet} />
      <div className="px-4 pb-3">
        {segments.map((segment, i) =>
          segment.type === "html" ? (
            <div
              key={i}
              className="prose max-w-none text-sm dark:prose-invert prose-headings:my-3 prose-p:my-2 prose-blockquote:border-l-muted-foreground/30 prose-blockquote:pl-4 prose-blockquote:not-italic prose-img:my-3 prose-img:rounded prose-hr:my-4"
              dangerouslySetInnerHTML={{ __html: segment.content }}
            />
          ) : (
            <div key={i} className="my-3 flex justify-center">
              <Tweet id={segment.id} />
            </div>
          ),
        )}
      </div>
      <TweetInfo tweet={tweet} />
      <TweetActions tweet={tweet} />
    </TweetContainer>
  );
}

function canRenderX(bookmark: ZBookmark): boolean {
  if (bookmark.content.type !== BookmarkTypes.LINK) {
    return false;
  }

  const url = bookmark.content.url;
  return extractTweetId(url) !== null;
}

function XRendererComponent({ bookmark }: { bookmark: ZBookmark }) {
  const api = useTRPC();

  const { data: htmlContent } = useQuery(
    api.bookmarks.getBookmark.queryOptions(
      {
        bookmarkId: bookmark.id,
        includeContent: true,
      },
      {
        select: (data) =>
          data.content.type === BookmarkTypes.LINK
            ? data.content.htmlContent
            : null,
      },
    ),
  );

  const isArticle = useMemo(() => {
    if (!htmlContent) return false;
    return isArticleContent(htmlContent);
  }, [htmlContent]);

  const articleSegments = useMemo(() => {
    if (!htmlContent || !isArticle) return [];
    return parseArticleSegments(htmlContent);
  }, [htmlContent, isArticle]);

  const replyTweetIds = useMemo(() => {
    if (!htmlContent) return [];
    return extractReplyTweetIds(htmlContent);
  }, [htmlContent]);

  if (bookmark.content.type !== BookmarkTypes.LINK) {
    return null;
  }

  const tweetId = extractTweetId(bookmark.content.url);
  if (!tweetId) {
    return null;
  }

  // Article view — custom tweet with article content replacing body
  if (isArticle && articleSegments.length > 0) {
    return (
      <div className="relative h-full w-full overflow-auto">
        <div className="flex justify-center p-4">
          <ArticleTweetEmbed tweetId={tweetId} segments={articleSegments} />
        </div>
        {replyTweetIds.length > 0 && (
          <div className="flex flex-col items-center gap-4 px-4 pb-8">
            {replyTweetIds.map((id) => (
              <Tweet key={id} id={id} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Regular tweet view with optional replies
  return (
    <div className="relative h-full w-full overflow-auto">
      <div className="flex justify-center p-4">
        <Tweet id={tweetId} />
      </div>
      {replyTweetIds.length > 0 && (
        <div className="flex flex-col items-center gap-4 px-4 pb-8">
          {replyTweetIds.map((id) => (
            <Tweet key={id} id={id} />
          ))}
        </div>
      )}
    </div>
  );
}

export const xRenderer: ContentRenderer = {
  id: "x",
  name: "X (Twitter)",
  icon: MessageSquare,
  canRender: canRenderX,
  component: XRendererComponent,
  priority: 10,
};
