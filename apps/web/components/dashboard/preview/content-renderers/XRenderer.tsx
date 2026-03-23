import { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { Tweet } from "react-tweet";
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
 * Our Twitter plugin embeds timestamp links to each reply's tweet URL
 * (e.g. https://x.com/user/status/12345) inside blockquotes after <h3>Replies</h3>.
 * We parse those to get the reply tweet IDs.
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
