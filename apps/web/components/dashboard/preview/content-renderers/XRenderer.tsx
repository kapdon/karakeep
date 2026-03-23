import { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import {
  enrichTweet,
  QuotedTweet,
  TweetActions,
  TweetBody,
  TweetContainer,
  TweetHeader,
  TweetInReplyTo,
  TweetInfo,
  TweetMedia,
  TweetNotFound,
  TweetSkeleton,
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
 * Extract the replies section from the cached HTML content.
 * Our Twitter plugin generates HTML with <h3>Replies</h3> followed by <blockquote> elements.
 */
function extractRepliesHtml(html: string): string | null {
  const repliesIdx = html.indexOf("<h3>Replies</h3>");
  if (repliesIdx === -1) {
    return null;
  }
  return html.slice(repliesIdx);
}

function canRenderX(bookmark: ZBookmark): boolean {
  if (bookmark.content.type !== BookmarkTypes.LINK) {
    return false;
  }

  const url = bookmark.content.url;
  return extractTweetId(url) !== null;
}

/**
 * Custom embedded tweet that replaces TweetReplies ("Read N replies" link)
 * with actual reply content extracted by our crawler plugin.
 */
function CustomEmbeddedTweet({
  tweetId,
  repliesHtml,
}: {
  tweetId: string;
  repliesHtml: string | null;
}) {
  const { data, error, isLoading } = useTweet(tweetId);

  if (isLoading) return <TweetSkeleton />;
  if (error || !data) return <TweetNotFound error={error} />;

  const tweet = enrichTweet(data);

  return (
    <TweetContainer>
      <TweetHeader tweet={tweet} />
      {tweet.in_reply_to_status_id_str && <TweetInReplyTo tweet={tweet} />}
      <TweetBody tweet={tweet} />
      {tweet.mediaDetails?.length ? <TweetMedia tweet={tweet} /> : null}
      {tweet.quoted_tweet && <QuotedTweet tweet={tweet.quoted_tweet} />}
      <TweetInfo tweet={tweet} />
      <TweetActions tweet={tweet} />
      {repliesHtml && (
        <div
          className="prose max-w-none px-4 pb-3 pt-1 dark:prose-invert prose-p:my-1 prose-blockquote:border-l-muted-foreground/30 prose-blockquote:pl-4 prose-blockquote:not-italic prose-img:my-2 prose-hr:my-4"
          dangerouslySetInnerHTML={{ __html: repliesHtml }}
        />
      )}
    </TweetContainer>
  );
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

  const repliesHtml = useMemo(() => {
    if (!htmlContent) return null;
    return extractRepliesHtml(htmlContent);
  }, [htmlContent]);

  if (bookmark.content.type !== BookmarkTypes.LINK) {
    return null;
  }

  const tweetId = extractTweetId(bookmark.content.url);
  if (!tweetId) {
    return null;
  }

  return (
    <div className="relative h-full w-full overflow-auto">
      <div className="flex justify-center p-4">
        <CustomEmbeddedTweet tweetId={tweetId} repliesHtml={repliesHtml} />
      </div>
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
