import { bytesToHex } from "./address";

const WINDOW_MS = 3_600_000;

export async function hashIp(ip: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  return bytesToHex(new Uint8Array(signature)).slice(0, 32);
}

function readStamps(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  } catch {
    return [];
  }
}

/**
 * 直近1時間の発行回数で判定する（I-3）。
 *
 * 以前は `floor(now / 3600000)` の固定バケットだったので、境界をまたぐとカウンタが即 0 に戻り、
 * 「2秒間に上限の2倍」が通った。時刻の配列を持ち、`nowMs` から遡って数えることで境界を無くす。
 * 配列は上限件数までしか持たないので、KV に入る値は上限に比例した固定長で収まる。
 * KV の read-modify-write なので、同時到着の取りこぼしは MVP では許容する。
 */
export async function checkAndCount(
  kv: KVNamespace,
  ipHash: string,
  limit: number,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const key = `rl:issue:${ipHash}`;
  const windowStart = nowMs - WINDOW_MS;
  const recent = readStamps(await kv.get(key))
    .filter((stamp) => stamp > windowStart)
    .sort((a, b) => a - b);

  if (recent.length >= limit) {
    // 上限番目に古い発行が窓から外れた瞬間に1枠空く
    const oldestBlocking = recent[recent.length - limit];
    return { ok: false, retryAfter: Math.max(1, Math.ceil((oldestBlocking + WINDOW_MS - nowMs) / 1000)) };
  }
  const next = [...recent, nowMs].slice(-Math.max(1, limit));
  await kv.put(key, JSON.stringify(next), { expirationTtl: WINDOW_MS / 1000 });
  return { ok: true };
}
