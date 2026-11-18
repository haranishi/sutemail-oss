import { describe, expect, it } from "vitest";
import { htmlToTextAndLinks } from "../../src/lib/html-text";

describe("htmlToTextAndLinks", () => {
  it("HTML の文字参照を解釈し、確認リンクの引数名を保つ", async () => {
    const result = await htmlToTextAndLinks(
      '<p>R&amp;D</p><a href="https://example.test/verify?x=1&amp;code=123">R&#38;D</a>',
    );
    expect(result.links).toEqual([{ url: "https://example.test/verify?x=1&code=123", label: "R&D" }]);
    expect(result.text).toContain("R&D");
  });

  it("危険要素を除き、改行とリンク表示名を得る", async () => {
    const result = await htmlToTextAndLinks(
      "<html><head><title>hidden</title></head><body><style>.x{color:red}</style><p>認証コード</p><div>482913<br>次</div><a href='https://example.com/verify'>確認する</a><script>alert(1)</script></body></html>",
    );
    expect(result.text).toContain("認証コード\n\n482913\n次");
    expect(result.text).not.toMatch(/hidden|color|alert/);
    expect(result.links).toEqual([{ url: "https://example.com/verify", label: "確認する" }]);
  });
});
