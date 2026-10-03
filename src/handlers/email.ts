import PostalMime from "postal-mime";
import { isValidLocalPart } from "../lib/address";
import { getMaxRawBytes, getMessageTtlSeconds } from "../lib/env";
import { extractCodes, extractLinks } from "../lib/extract";
import { htmlToTextAndLinks } from "../lib/html-text";
import { notifyNewMessage } from "../lib/push";
import { getAddress, putMessage, type StoredMessage } from "../lib/store";
import type { Env, IncomingMessage } from "../types";

export type IncomingResult =
  | { ok: true; message: StoredMessage }
  | { ok: false; reason: "Message too large" | "Mailbox unavailable" };

export interface IncomingOptions {
  now?: number;
  /**
   * `ExecutionContext` があれば通知の送信を待たずに返す。
   * 無い経路（開発用の注入）は await して、テストから結果が見えるようにする。
   */
  ctx?: Pick<ExecutionContext, "waitUntil">;
}

export async function handleIncoming(
  message: IncomingMessage,
  env: Env,
  options: IncomingOptions = {},
): Promise<IncomingResult> {
  const now = options.now ?? Date.now();
  const maxRawBytes = getMaxRawBytes(env);
  if (message.rawSize > maxRawBytes) return { ok: false, reason: "Message too large" };

  const at = message.to.lastIndexOf("@");
  const local = at > 0 ? message.to.slice(0, at).toLowerCase() : "";
  const domain = at > 0 ? message.to.slice(at + 1).toLowerCase() : "";
  if (!isValidLocalPart(local) || domain !== env.MAIL_DOMAIN.toLowerCase()) {
    return { ok: false, reason: "Mailbox unavailable" };
  }
  const address = await getAddress(env.INBOX, local);
  if (!address || address.expiresAt <= now) return { ok: false, reason: "Mailbox unavailable" };

  const parsed = await PostalMime.parse(message.raw, { attachmentEncoding: "utf8", maxNestingDepth: 4 });
  const htmlResult = parsed.html ? await htmlToTextAndLinks(parsed.html) : { text: "", links: [] };
  const text = (parsed.text || htmlResult.text).normalize("NFKC").slice(0, 20_000);
  const subject = (parsed.subject ?? "").normalize("NFKC").slice(0, 200);
  const receivedAt = now;
  const stored: StoredMessage = {
    id: crypto.randomUUID(),
    from: parsed.from?.address ?? message.from,
    subject,
    receivedAt,
    codes: extractCodes({ subject, text }),
    links: extractLinks({ text, htmlLinks: htmlResult.links }),
    text,
  };
  const remainingAddressSeconds = Math.max(0, Math.ceil((address.expiresAt - now) / 1000));
  await putMessage(env.INBOX, local, stored, remainingAddressSeconds, getMessageTtlSeconds(env));

  // 通知は保存の後（届いた通知を出したのに本文が無い、を避ける）。中身は「届いた」だけでコードは載せない
  const notify = notifyNewMessage(env, local, address.pushSub);
  if (options.ctx) options.ctx.waitUntil(notify);
  else await notify;

  return { ok: true, message: stored };
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const result = await handleIncoming(
    { from: message.from, to: message.to, raw: message.raw, rawSize: message.rawSize },
    env,
    { ctx },
  );
  if (!result.ok) message.setReject(result.reason);
}
