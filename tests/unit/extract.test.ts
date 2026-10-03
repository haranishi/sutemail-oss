import { describe, expect, it } from "vitest";
import { extractCodes, extractLinks } from "../../src/lib/extract";

describe("extractCodes", () => {
  it.each([
    ["Supabase", "Your verification code is 482913.", "482913"],
    ["Auth0", "Login code\n731905", "731905"],
    ["Cognito", "Authentication code: 640218", "640218"],
    ["Clerk", "Your one-time password is 424242.", "424242"],
    ["Slack", "Your code is 385104", "385104"],
    ["Dropbox", "Security code: 492731", "492731"],
    ["Shopify login code", "847205", "847205"],
    ["Notion", "ワンタイムコード\n615903", "615903"],
    ["確認コードのお知らせ", "286419", "286419"],
    ["Microsoft", "7391042 is your security code", "7391042"],
    ["認証コード", "４８２９１３", "482913"],
    ["OTP", "OTP\n112233", "112233"],
    ["ログイン用番号", "99887766", "99887766"],
  ])("A2b相当 %s", (subject, text, expected) => {
    expect(extractCodes({ subject, text })).toContainEqual(expect.objectContaining({ value: expected, confidence: "high" }));
  });

  it.each([
    ["電話番号", "電話 03-1234-5678"],
    ["国際電話", "電話 +81-90-1234-5678"],
    ["郵便番号", "〒123-4567"],
    ["金額", "合計 ¥12,800"],
    ["注文番号", "order number 7654321"],
    ["日付時刻", "2026/09/05 12:34"],
    ["IPv4", "192.168.10.20"],
    ["URL", "https://example.com/order/998877"],
  ])("%sを誤検出しない", (_name, text) => {
    expect(extractCodes({ text, includeLow: true })).toEqual([]);
  });

  it("文脈なしの候補は既定で返さない", () => {
    expect(extractCodes({ text: "番号は 123456 です" })).toEqual([]);
    expect(extractCodes({ text: "番号は 123456 です", includeLow: true })[0]?.confidence).toBe("low");
  });

  it("同点候補を両方返す", () => {
    expect(extractCodes({ text: "認証コード: 123456 または 654321" }).map((code) => code.value)).toEqual([
      "123456",
      "654321",
    ]);
  });

  it("除外語と強いラベルが同じ文脈なら返さない（I-1・FR-03「除外」）", () => {
    // 以前は medium に落として画面に残していた。FR-03 は「除外」なので候補ごと捨てる
    expect(extractCodes({ text: "認証コード 注文番号 123456" })).toEqual([]);
    expect(extractCodes({ text: "認証コード 注文番号 123456", includeLow: true })).toEqual([]);
  });

  const values = (input: { subject?: string; text: string }) => extractCodes(input).map((code) => code.value);

  describe("F-1 ラベル行の隣の数字を昇格させない", () => {
    it.each([
      ["次行に西暦", "確認コード: 482913\n有効期限 2026 年 9 月", ["482913"]],
      ["同じ行に西暦（HTMLのテキスト化で起きる）", "確認コード: 482913 有効期限 2026 年 9 月", ["482913"]],
      ["次行に会員番号", "認証コードは 482913 です\n会員番号 90210033", ["482913"]],
      ["同じ行に会員番号", "認証コード 482913 会員番号 90210033", ["482913"]],
      ["IPと(c)西暦", "認証コード 508233\n接続元 192.168.10.24\n(c) 2026", ["508233"]],
    ])("%s", (_name, text, expected) => {
      expect(values({ subject: "認証コード", text })).toEqual(expected);
    });

    it("散文中の数字は同一行にラベルがあるときだけ拾う", () => {
      // 独立行なら隣接ラベルで昇格する（既存の型②を壊さない）
      expect(values({ subject: "Notion", text: "ワンタイムコード\n615903" })).toEqual(["615903"]);
      // 語が混ざった行は隣接ラベルの恩恵を受けない
      expect(values({ subject: "Notion", text: "ワンタイムコード\nお問い合わせ番号は 615903 です" })).toEqual([]);
    });

    it("8桁のYYYYMMDDは日付として捨てる", () => {
      expect(values({ subject: "認証コード", text: "認証コード 20260905" })).toEqual([]);
    });

    it("ラベル語そのものは除外語にしない", () => {
      expect(values({ subject: "認証番号", text: "認証番号 640287" })).toEqual(["640287"]);
      expect(values({ subject: "確認番号", text: "確認番号 640287" })).toEqual(["640287"]);
    });

    it("日付が同じ行にあってもコード側は残す", () => {
      expect(values({ subject: "認証コード", text: "認証コード 482913 有効期限 2026年9月5日" })).toEqual(["482913"]);
    });
  });

  describe("I-1 除外語の文脈にある数字を候補にしない", () => {
    it("金額（カンマなし）を捨てる", () => {
      expect(values({ subject: "認証番号", text: "認証番号 640287\n合計 3980円 のお支払いです。" })).toEqual(["640287"]);
    });

    it("注文番号を捨てる", () => {
      expect(
        values({ subject: "ご注文の確認コード", text: "確認コードは 209471 です。\nご注文番号 20260905 をお控えください。" }),
      ).toEqual(["209471"]);
    });

    it("直前2行に除外語がある独立行は medium にしない", () => {
      expect(values({ subject: "認証のお知らせ", text: "合計 3980円\n123456" })).toEqual([]);
      // 除外語が3行以上前なら独立行の medium は残る
      expect(values({ subject: "認証のお知らせ", text: "合計 3980円\n\n\n123456" })).toEqual(["123456"]);
    });
  });

  describe("I-6 件名のコードを拾う", () => {
    it("本文に数字が無くても件名から high で取る", () => {
      expect(extractCodes({ subject: "【Example】認証コード 482913", text: "本文に数字はありません。" })).toEqual([
        expect.objectContaining({ value: "482913", confidence: "high" }),
      ]);
    });

    it("件名にラベルが無ければ拾わない", () => {
      expect(values({ subject: "【Example】お知らせ 482913", text: "本文に数字はありません。" })).toEqual([]);
    });
  });
});

describe("extractLinks", () => {
  it("優先リンクを先にし、追跡解除リンクを除外する", () => {
    const links = extractLinks({
      text: "https://example.com/help https://example.com/unsubscribe",
      htmlLinks: [{ url: "https://auth.example.com/action?oobCode=secret", label: "Verify email" }],
    });
    expect(links.map((link) => link.host)).toEqual(["auth.example.com", "example.com"]);
    expect(links[0].priority).toBe(0);
  });

  it("壊れたURLとmailtoを除外する", () => {
    expect(extractLinks({ text: "", htmlLinks: [{ url: "mailto:a@example.com", label: "mail" }, { url: "://", label: "x" }] })).toEqual([]);
  });
});
