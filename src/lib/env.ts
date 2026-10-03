import type { Env } from "../types";

/**
 * 数値の環境変数を1か所で読む（I-4）。
 *
 * `Number.parseInt(undefined)` は `NaN` になり、`count >= NaN` も `size > NaN` も false になる。
 * つまり vars を1行消しただけで、レート制限もサイズ上限も黙って外れる。
 * ここで「欠落・数値でない・範囲外」をすべて既定値へ倒し、制限が無制限側に倒れないようにする。
 */
export function readIntEnv(raw: string | undefined, fallbackValue: number, min: number, max: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallbackValue;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallbackValue;
  if (parsed < min || parsed > max) return fallbackValue;
  return parsed;
}

/** アドレスの寿命（秒）。下限は KV の TTL 下限、上限は NFR-02 の「最大1時間」。 */
export const ADDRESS_TTL_DEFAULT = 600;
/** メッセージの寿命（秒）。アドレス残り時間との min を取るので、これ単体では延びない。 */
export const MESSAGE_TTL_DEFAULT = 600;
/** 1時間あたりの発行上限（IPハッシュごと）。 */
export const ISSUE_LIMIT_DEFAULT = 10;
/** 受信メールの生バイト上限。既定256KB、上限は Email Routing の 25MiB。 */
export const MAX_RAW_BYTES_DEFAULT = 262_144;

export function getAddressTtlSeconds(env: Env): number {
  return readIntEnv(env.ADDRESS_TTL_SECONDS, ADDRESS_TTL_DEFAULT, 60, 3600);
}

export function getMessageTtlSeconds(env: Env): number {
  return readIntEnv(env.MESSAGE_TTL_SECONDS, MESSAGE_TTL_DEFAULT, 60, 3600);
}

export function getIssueLimitPerHour(env: Env): number {
  return readIntEnv(env.ISSUE_LIMIT_PER_HOUR, ISSUE_LIMIT_DEFAULT, 1, 1000);
}

export function getMaxRawBytes(env: Env): number {
  return readIntEnv(env.MAX_RAW_BYTES, MAX_RAW_BYTES_DEFAULT, 1024, 26_214_400);
}

/** サイトキーと秘密鍵の両方が揃ったときだけ Turnstile を要求する（FR-12）。CSP の分岐にも使う。 */
export function isTurnstileEnabled(env: Env): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim());
}
