import type { AddressRecord } from "./lib/store";

export interface Env {
  INBOX: KVNamespace;
  ASSETS: Fetcher;
  MAIL_DOMAIN: string;
  APP_ORIGIN: string;
  /**
   * 数値の vars は「欠けているかもしれない」型にしてある（I-4）。
   * こう書いておくと `Number.parseInt(env.X, 10)` が型エラーになり、
   * 既定値へ倒す `src/lib/env.ts` を通す以外に読めなくなる。
   */
  ADDRESS_TTL_SECONDS?: string;
  MESSAGE_TTL_SECONDS?: string;
  ISSUE_LIMIT_PER_HOUR?: string;
  MAX_RAW_BYTES?: string;
  IP_HASH_SECRET: string;
  DEV_INJECT?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface IncomingMessage {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string;
  rawSize: number;
}

export interface AuthenticatedAddress {
  local: string;
  record: AddressRecord;
}
