import { describe, expect, test } from "vitest";

import {
  extractXArticleRepliesFromStatusHtml,
  extractXArticleUrlFromStatusHtml,
} from "./xStatusPage";

describe("extractXArticleUrlFromStatusHtml", () => {
  test("only returns article links from the bookmarked tweet", () => {
    const html = `
      <div data-testid="tweet">
        <a href="/parent/status/100">Mar 1</a>
        <a href="/parent/article/111">wrong article</a>
      </div>
      <div data-testid="tweet">
        <a href="/main/status/200">Mar 2</a>
        <a href="/main/article/222">correct article</a>
        <div data-testid="tweet">
          <a href="/quoted/status/300">quoted tweet</a>
          <a href="/quoted/article/333">nested article</a>
        </div>
      </div>
      <div data-testid="tweet">
        <a href="/reply/status/400">Mar 3</a>
        <a href="/reply/article/444">reply article</a>
      </div>
    `;

    expect(
      extractXArticleUrlFromStatusHtml(html, "https://x.com/main/status/200"),
    ).toBe("https://x.com/main/article/222");
  });
});

describe("extractXArticleRepliesFromStatusHtml", () => {
  test("uses the bookmarked tweet instead of the first rendered tweet", () => {
    const html = `
      <div data-testid="tweet">
        <a role="link" href="/parent">Parent User</a>
        <a role="link" href="/parent">@parent</a>
        <a href="/parent/status/100">Mar 1</a>
        <div data-testid="tweetText">Parent thread context</div>
      </div>
      <div data-testid="tweet">
        <a role="link" href="/main">Main User</a>
        <a role="link" href="/main">@main</a>
        <a href="/main/status/200">Mar 2</a>
        <div data-testid="tweetText">Bookmarked article tweet</div>
      </div>
      <div data-testid="tweet">
        <a role="link" href="/reply">Reply User</a>
        <a role="link" href="/reply">@reply</a>
        <a href="/reply/status/300">Mar 3</a>
        <div data-testid="tweetText">Actual reply</div>
      </div>
    `;

    expect(
      extractXArticleRepliesFromStatusHtml(
        html,
        "https://x.com/main/status/200",
      ),
    ).toEqual([
      {
        author: "Reply User",
        handle: "@reply",
        statusUrl: "https://x.com/reply/status/300",
        text: "Actual reply",
      },
    ]);
  });

  test("ignores nested quoted tweets when collecting replies", () => {
    const html = `
      <div data-testid="tweet">
        <a role="link" href="/main">Main User</a>
        <a role="link" href="/main">@main</a>
        <a href="/main/status/200">Mar 2</a>
        <div data-testid="tweetText">Bookmarked article tweet</div>
        <div data-testid="tweet">
          <a role="link" href="/quoted">Quoted User</a>
          <a role="link" href="/quoted">@quoted</a>
          <a href="/quoted/status/250">Nested quote</a>
          <div data-testid="tweetText">Quoted tweet text</div>
        </div>
      </div>
      <div data-testid="tweet">
        <a role="link" href="/reply">Reply User</a>
        <a role="link" href="/reply">@reply</a>
        <a href="/reply/status/300">Mar 3</a>
        <div data-testid="tweetText">Actual reply</div>
      </div>
    `;

    expect(
      extractXArticleRepliesFromStatusHtml(
        html,
        "https://x.com/main/status/200",
      ),
    ).toEqual([
      {
        author: "Reply User",
        handle: "@reply",
        statusUrl: "https://x.com/reply/status/300",
        text: "Actual reply",
      },
    ]);
  });
});
