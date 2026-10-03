import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleEmail, handleIncoming } from "../../src/handlers/email";
import { hashToken } from "../../src/lib/address";
import { listMessages, putAddress, putMessage } from "../../src/lib/store";
import type { Env } from "../../src/types";
import supabase from "../fixtures/supabase-plain.eml?raw";
import auth0 from "../fixtures/auth0-html.eml?raw";
import cognito from "../fixtures/cognito-multipart.eml?raw";
import clerk from "../fixtures/clerk-plain.eml?raw";
import slack from "../fixtures/slack-html.eml?raw";
import dropbox from "../fixtures/dropbox-plain.eml?raw";
import shopify from "../fixtures/shopify-multipart.eml?raw";
import notion from "../fixtures/notion-html.eml?raw";
import google from "../fixtures/google-subject.eml?raw";
import microsoft from "../fixtures/microsoft-plain.eml?raw";
import firebase from "../fixtures/firebase-link.eml?raw";
import cognitoLink from "../fixtures/cognito-link.eml?raw";
import github from "../fixtures/github-link.eml?raw";
import falsePositive from "../fixtures/false-positive.eml?raw";
import fullwidth from "../fixtures/fullwidth.eml?raw";

const testEnv = env as unknown as Env;
const local = "abcdefgh23";
const to = `${local}@sutemail.test`;

function stream(raw: string): ReadableStream<Uint8Array> {
  return new Response(raw).body!;
}

async function issue(expiresAt = Date.now() + 600_000): Promise<void> {
  await putAddress(env.INBOX, local, { tokenHash: await hashToken("token"), createdAt: Date.now(), expiresAt }, 600);
}

describe("email handler", () => {
  it("未発行宛先を本文を解析せず拒否する", async () => {
    const reject = vi.fn();
    await handleEmail(
      { from: "noreply@example.com", to, raw: stream(supabase), rawSize: supabase.length, setReject: reject } as unknown as ForwardableEmailMessage,
      testEnv,
    );
    expect(reject).toHaveBeenCalledWith("Mailbox unavailable");
  });

  it("失効宛先を拒否する", async () => {
    await issue(Date.now() - 1);
    const result = await handleIncoming({ from: "noreply@example.com", to, raw: stream(supabase), rawSize: supabase.length }, testEnv);
    expect(result).toEqual({ ok: false, reason: "Mailbox unavailable" });
  });

  it("256KB超を本文を読まず拒否する", async () => {
    await issue();
    const raw = `Message-ID: <big@example.com>\n\n${"x".repeat(300 * 1024)}`;
    const result = await handleIncoming({ from: "noreply@example.com", to, raw: stream(raw), rawSize: raw.length }, testEnv);
    expect(result).toEqual({ ok: false, reason: "Message too large" });
  });

  it("A2b合成fixtureを解析し、コードとリンクを保存する", async () => {
    await issue();
    const codeFixtures: [string, string][] = [
      [supabase, "482913"], [auth0, "731905"], [cognito, "640218"], [clerk, "424242"], [slack, "385104"],
      [dropbox, "492731"], [shopify, "847205"], [notion, "615903"], [google, "286419"], [microsoft, "7391042"],
      [fullwidth, "482913"],
    ];
    for (const [raw, expected] of codeFixtures) {
      const result = await handleIncoming({ from: "fallback@example.com", to, raw: stream(raw), rawSize: raw.length }, testEnv);
      expect(result.ok && result.message.codes, JSON.stringify(result)).toContainEqual(
        expect.objectContaining({ value: expected, confidence: "high" }),
      );
    }
    for (const [raw, expectedPart] of [[firebase, "oobCode"], [cognitoLink, "confirmation_code"], [github, "token="]] as const) {
      const result = await handleIncoming({ from: "fallback@example.com", to, raw: stream(raw), rawSize: raw.length }, testEnv);
      expect(result.ok && result.message.links[0]?.url).toContain(expectedPart);
    }
    const messages = await listMessages(env.INBOX, local);
    expect(messages).toHaveLength(14);
    expect(messages.every((message) => message.text.length <= 20_000)).toBe(true);
  });

  it("同じミリ秒に届いた2通でも一覧の並びが決まる", async () => {
    await issue();
    const receivedAt = 1_700_000_000_000;
    for (const id of ["msg-0003", "msg-0001", "msg-0002"]) {
      await putMessage(
        env.INBOX,
        local,
        { id, from: "a@example.com", subject: "s", receivedAt, codes: [], links: [], text: "" },
        600,
        600,
      );
    }
    // receivedAt が同点なら id の降順。何度読んでも同じ並びになる
    const first = await listMessages(env.INBOX, local);
    const second = await listMessages(env.INBOX, local);
    expect(first.map((message) => message.id)).toEqual(["msg-0003", "msg-0002", "msg-0001"]);
    expect(second.map((message) => message.id)).toEqual(first.map((message) => message.id));
  });

  it("誤検出fixtureからコードを保存しない", async () => {
    await issue();
    const result = await handleIncoming({ from: "shop@example.com", to, raw: stream(falsePositive), rawSize: falsePositive.length }, testEnv);
    expect(result.ok && result.message.codes).toEqual([]);
  });
});
