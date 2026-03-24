import { load } from "cheerio";
import { describe, expect, test } from "vitest";

import { __private } from "./metascraper-twitter";

describe("extractFromDom", () => {
  test("ignores nested quoted tweets when classifying thread and replies", () => {
    const html = `
      <div data-testid="tweet">
        <a role="link" href="/main">Main User</a>
        <a role="link" href="/main">@main</a>
        <a href="/main/status/200">Mar 2</a>
        <time datetime="2026-03-22T10:00:00.000Z"></time>
        <div data-testid="tweetText">Main tweet text</div>
        <div data-testid="tweet">
          <a role="link" href="/quoted">Quoted User</a>
          <a role="link" href="/quoted">@quoted</a>
          <a href="/quoted/status/250">Quoted</a>
          <time datetime="2026-03-22T10:01:00.000Z"></time>
          <div data-testid="tweetText">Quoted tweet text</div>
        </div>
      </div>
      <div data-testid="tweet">
        <a role="link" href="/reply">Reply User</a>
        <a role="link" href="/reply">@reply</a>
        <a href="/reply/status/300">Mar 3</a>
        <time datetime="2026-03-22T10:02:00.000Z"></time>
        <div data-testid="tweetText">Actual reply</div>
      </div>
    `;

    const content = __private.extractFromDom(
      load(html),
      "https://x.com/main/status/200",
    );

    expect(content).toContain("Main tweet text");
    expect(content).toContain("Actual reply");
    expect(content).not.toContain("Quoted tweet text");
    expect(content).not.toContain("https://x.com/quoted/status/250");
  });
});
