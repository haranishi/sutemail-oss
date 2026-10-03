export interface PushSubscriptionRecord {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

/** `idx:` が持つメッセージの索引1件。値は持たず、鍵と並べ替えに要る情報だけ。 */
export interface MessageIndexEntry {
  key: string;
  receivedAt: number;
  id: string;
}

/**
 * 受信済みメッセージの索引（I-2・N-1）。`addr:` とは別の鍵に置く。
 * `addr:` に相乗りさせていたときは、購読の保存・報告・`pushSent` の read-modify-write が
 * 索引ごと古い値で上書きし、届いたメールが一覧から消えることがあった（レビュー r2 N-1）。
 * これを書くのは受信経路（`putMessage`）と `DELETE`（掃除）だけにする。
 */
export interface MessageIndexRecord {
  messages: MessageIndexEntry[];
}

export interface AddressRecord {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  pushSub?: PushSubscriptionRecord;
  /** このアドレスから報告済みのホスト。同じホストを二度数えないための控え。 */
  reportedHosts?: string[];
  /** このアドレスから送った Push の回数。増幅の踏み台にしないための上限判定に使う。 */
  pushSent?: number;
}

export interface CodeCandidate {
  value: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface LinkCandidate {
  host: string;
  url: string;
  label: string;
  priority: number;
}

export interface StoredMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: number;
  codes: CodeCandidate[];
  links: LinkCandidate[];
  text: string;
}

export interface DeliveryStat {
  ok: number;
  ng: number;
  updatedAt: number;
}

export interface StatEntry {
  host: string;
  ok: number;
  ng: number;
}

/** 1アドレスが報告できるホスト数の上限。10分しか生きないアドレスなので、通常は数件で足りる。 */
export const MAX_REPORTED_HOSTS = 20;

/**
 * 索引に載せるメッセージ数の上限。溢れた古い鍵は TTL で消え、消え残りは DELETE 時の掃除で拾う。
 * 10分のアドレスに50通も来るのは通常の使い方ではない。
 */
export const MAX_INDEXED_MESSAGES = 50;

/** 1アドレスあたりの Push 送信回数の上限。外向き POST の増幅装置にしないための蓋。 */
export const MAX_PUSH_SENDS = 20;

/**
 * ポーリング経路の KV 読み取りに付けるエッジキャッシュの秒数（N-2）。
 * 既定（60秒）のままだと、受信を書いたコロと読んでいるコロが違うときに
 * 最悪60秒表示が遅れる。いまの最小値まで下げて最悪30秒に縮める。
 * 根本解（Durable Object で強整合）は本番 KV の実測を見てから判断する（docs/03_architecture.md §3）。
 */
export const POLL_CACHE_TTL = 30;

const STAT_PREFIX = "stat:";

export async function putAddress(kv: KVNamespace, local: string, value: AddressRecord, ttl: number): Promise<void> {
  await kv.put(`addr:${local}`, JSON.stringify(value), { expirationTtl: Math.max(60, ttl) });
}

export async function getAddress(kv: KVNamespace, local: string): Promise<AddressRecord | null> {
  return kv.get<AddressRecord>(`addr:${local}`, "json");
}

export async function deleteAddress(kv: KVNamespace, local: string): Promise<void> {
  await kv.delete(`addr:${local}`);
}

/**
 * `addr:` を読み直して書き戻す。KV の TTL は論理失効時刻から計算し直すので、
 * 書き戻しでアドレスの寿命が延びることはない（`expiresAt` は触らない）。
 */
async function rewriteAddress(kv: KVNamespace, local: string, record: AddressRecord, now: number): Promise<void> {
  await putAddress(kv, local, record, Math.ceil((record.expiresAt - now) / 1000));
}

/** 購読を保存する。`sub` が null なら解除。アドレスが無い・失効していれば false。 */
export async function setPushSubscription(
  kv: KVNamespace,
  local: string,
  sub: PushSubscriptionRecord | null,
  now = Date.now(),
): Promise<boolean> {
  const record = await getAddress(kv, local);
  if (!record || record.expiresAt <= now) return false;
  const next: AddressRecord = { ...record };
  if (sub) next.pushSub = sub;
  else delete next.pushSub;
  await rewriteAddress(kv, local, next, now);
  return true;
}

export type ReportMark = "recorded" | "duplicate" | "full" | "missing";

/**
 * このアドレスがまだ報告していないホストなら控えに足す。
 * 競合は許容する（KV は read-modify-write なので、同時報告は取りこぼしうる）。
 */
export async function markHostReported(
  kv: KVNamespace,
  local: string,
  host: string,
  now = Date.now(),
): Promise<ReportMark> {
  const record = await getAddress(kv, local);
  if (!record || record.expiresAt <= now) return "missing";
  const reported = record.reportedHosts ?? [];
  if (reported.includes(host)) return "duplicate";
  if (reported.length >= MAX_REPORTED_HOSTS) return "full";
  await rewriteAddress(kv, local, { ...record, reportedHosts: [...reported, host] }, now);
  return "recorded";
}

function messageKey(local: string, message: StoredMessage): string {
  return `msg:${local}:${message.receivedAt}-${message.id.slice(-4)}`;
}

function indexKey(local: string): string {
  return `idx:${local}`;
}

/** 読み取りの共通オプション。ポーリング経路だけ `cacheTtl` を縮める（N-2）。 */
export interface ReadOptions {
  cacheTtl?: number;
}

/** 索引を読む。無ければ空配列（まだ1通も届いていない）。 */
export async function getMessageIndex(
  kv: KVNamespace,
  local: string,
  options: ReadOptions = {},
): Promise<MessageIndexEntry[]> {
  const record = await kv.get<MessageIndexRecord>(indexKey(local), { type: "json", ...options });
  return Array.isArray(record?.messages) ? record.messages : [];
}

/**
 * 索引に1件足す（`idx:` の read-modify-write）。
 * `addr:` は触らないので、購読・報告・`pushSent` の書き戻しと衝突しない（N-1）。
 * TTL はアドレスと同じにする（アドレスが消えれば索引も要らない）。
 */
async function addToMessageIndex(
  kv: KVNamespace,
  local: string,
  entry: MessageIndexEntry,
  addressTtlSeconds: number,
): Promise<void> {
  const current = await getMessageIndex(kv, local);
  const messages = [...current.filter((existing) => existing.key !== entry.key), entry]
    .sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-MAX_INDEXED_MESSAGES);
  await kv.put(indexKey(local), JSON.stringify({ messages } satisfies MessageIndexRecord), {
    expirationTtl: Math.max(60, addressTtlSeconds),
  });
}

export async function putMessage(
  kv: KVNamespace,
  local: string,
  message: StoredMessage,
  remainingAddressSeconds: number,
  messageTtlSeconds: number,
): Promise<void> {
  const ttl = Math.max(60, Math.min(remainingAddressSeconds, messageTtlSeconds));
  const key = messageKey(local, message);
  await kv.put(key, JSON.stringify(message), { expirationTtl: ttl });
  await addToMessageIndex(kv, local, { key, receivedAt: message.receivedAt, id: message.id }, remainingAddressSeconds);
}

/**
 * 一覧を `idx:` の索引から `get` だけで組み立てる（I-2）。
 * 以前は `kv.list` を1回ずつ走らせていて、3秒ポーリングだと10分で約88回＝KV の list 無料枠を食い潰した。
 */
export async function listMessages(
  kv: KVNamespace,
  local: string,
  options: ReadOptions = {},
): Promise<StoredMessage[]> {
  const entries = await getMessageIndex(kv, local, options);
  const messages = await Promise.all(
    entries.map((entry) => kv.get<StoredMessage>(entry.key, { type: "json", ...options })),
  );
  return messages
    .filter((message): message is StoredMessage => message !== null)
    // 同じミリ秒に2通届くと receivedAt だけでは順序が決まらないので、id を第二キーにして確定させる
    .sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function getMessage(
  kv: KVNamespace,
  local: string,
  id: string,
  options: ReadOptions = {},
): Promise<StoredMessage | null> {
  const entries = await getMessageIndex(kv, local, options);
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  return kv.get<StoredMessage>(entry.key, { type: "json", ...options });
}

/** 索引にある鍵と索引そのものを消したうえで、索引から漏れた鍵を `list` で掃除する（削除は頻度が低いので list を使ってよい）。 */
export async function deleteAllMessages(kv: KVNamespace, local: string): Promise<void> {
  const entries = await getMessageIndex(kv, local);
  await Promise.all([...entries.map((entry) => kv.delete(entry.key)), kv.delete(indexKey(local))]);
  let cursor: string | undefined;
  do {
    const listed = await kv.list({ prefix: `msg:${local}:`, cursor });
    await Promise.all(listed.keys.map((key) => kv.delete(key.name)));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

/**
 * Push を1回分予約する。上限に達していれば false（送らない）。
 * 失敗も1回として数える——増幅を止めるのが目的なので、成功だけを数えると意味がなくなる。
 */
export async function reservePushSend(
  kv: KVNamespace,
  local: string,
  limit = MAX_PUSH_SENDS,
  now = Date.now(),
): Promise<boolean> {
  const record = await getAddress(kv, local);
  if (!record || record.expiresAt <= now) return false;
  const sent = record.pushSent ?? 0;
  if (sent >= limit) return false;
  await rewriteAddress(kv, local, { ...record, pushSent: sent + 1 }, now);
  return true;
}

export async function bumpStat(kv: KVNamespace, host: string, result: "ok" | "ng"): Promise<DeliveryStat> {
  const current = (await getStat(kv, host)) ?? { ok: 0, ng: 0, updatedAt: 0 };
  current[result] += 1;
  current.updatedAt = Date.now();
  // 集計を metadata にも持たせる。上位10件は list() のメタデータだけで並べられる＝
  // 1リクエストあたりのサブリクエスト上限（Free 50件）に触れずに済む。
  await kv.put(`${STAT_PREFIX}${host}`, JSON.stringify(current), {
    metadata: { ok: current.ok, ng: current.ng },
  });
  return current;
}

export async function getStat(kv: KVNamespace, host: string): Promise<DeliveryStat | null> {
  return kv.get<DeliveryStat>(`${STAT_PREFIX}${host}`, "json");
}

/**
 * 実績を件数の多い順に返す。値は読まず `list()` の metadata だけを使う。
 * metadata の無い古い鍵は 0件扱いになり、合計0として除かれる。
 */
export async function listStats(kv: KVNamespace, limit = 1000): Promise<StatEntry[]> {
  const listed = await kv.list<{ ok?: number; ng?: number }>({ prefix: STAT_PREFIX, limit });
  return listed.keys
    .map((key) => ({
      host: key.name.slice(STAT_PREFIX.length),
      ok: Number(key.metadata?.ok ?? 0),
      ng: Number(key.metadata?.ng ?? 0),
    }))
    .filter((entry) => entry.host.length > 0 && entry.ok + entry.ng > 0)
    .sort((a, b) => b.ok + b.ng - (a.ok + a.ng) || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}
