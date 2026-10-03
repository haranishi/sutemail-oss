import type { CodeCandidate, LinkCandidate } from "./store";

const LABEL_PATTERN =
  /(?:認証|確認|セキュリティ|ログイン(?:用)?)(?:コード|番号)|ワンタイム(?:パスワード|コード)|verification(?:\s+code)?|security\s+code|authentication\s+code|login\s+code|one[- ]time(?:\s+(?:password|passcode|code))?|\bOTP\b|your\s+code|code\s+is|確認コード|認証番号/i;
const OTP_WORD_PATTERN =
  /認証|確認|セキュリティ|ログイン|ワンタイム|verification|security\s+code|authentication|one[- ]time|\bOTP\b|your\s+code|code\s+is/i;
const EXCLUSION_CONTEXT = /注文(?:番号)?|order(?:\s*(?:number|no\.?|#))?|invoice|tracking|合計|金額|amount|total/i;
/**
 * 「この数字の直前に付く語」＝数字そのものが認証コードでないことを示すラベル（F-1）。
 * 窓で拾うと「認証コード 482913 有効期限 2026年9月5日」のような行で本命まで巻き込むので、
 * 数字の直前だけを見る。
 */
const IDENTIFIER_PREFIX = /(?:会員|社員|口座|\bNo\.?|\bID\b|電話|\bTEL\b|\bFAX\b|〒)[^\d\n]{0,8}$/i;
/** 数字の直後が年月日なら日付（「2026 年」「9 月」）。 */
const DATE_UNIT_SUFFIX = /^\s*[年月日]/;
/** 8桁の YYYYMMDD。注文番号・受付日として本文によく出る。 */
const YYYYMMDD_PATTERN = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
/** 単独の西暦4桁。ほかに候補があるときだけ落とす（コード自体が「2026」の可能性を残す）。 */
const YEAR_PATTERN = /^(?:19|20)\d{2}$/;
/** 独立行の medium を判断するとき、何行前まで除外語を見るか（I-1）。 */
const EXCLUSION_LOOKBACK_LINES = 2;
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/&amp;|&#39;|&#x27;|&nbsp;/gi, (entity) => ENTITY_MAP[entity.toLowerCase()] ?? entity)
    .replace(/\r\n?/g, "\n");
}

function redactExcluded(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/https?:\/\/[^\s<>"'）)]+/gi, " ")
    .replace(/<[^>]*\bmessage-id\b[^>]*>/gi, " ")
    .replace(/\b(?:message-id)\s*:\s*\S+/gi, " ")
    .replace(/\+81(?:[- ]?\d){8,12}/g, " ")
    .replace(/\b0\d{1,4}-\d{1,4}-\d{4}\b/g, " ")
    .replace(/〒?\s*\d{3}-\d{4}\b/g, " ")
    .replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, " ")
    .replace(/[¥￥$]\s*\d[\d,]*/g, " ")
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, " ");
}

function lineHasExcludedNumberContext(line: string, start: number, end: number): boolean {
  const context = line.slice(Math.max(0, start - 28), Math.min(line.length, end + 28));
  return EXCLUSION_CONTEXT.test(context);
}

/** 会員番号・電話・日付など、その数字が認証コードでないことを示す並びか（F-1）。 */
function looksLikeOtherIdentifier(line: string, value: string, start: number, end: number): boolean {
  if (YYYYMMDD_PATTERN.test(value)) return true;
  if (IDENTIFIER_PREFIX.test(line.slice(0, start))) return true;
  if (DATE_UNIT_SUFFIX.test(line.slice(end))) return true;
  return false;
}

/** 直前 N 行に除外語があるか（I-1）。「合計 3980円」の次行に並ぶ独立行を候補にしない。 */
function precededByExclusion(lines: string[], lineIndex: number): boolean {
  for (let index = Math.max(0, lineIndex - EXCLUSION_LOOKBACK_LINES); index < lineIndex; index += 1) {
    if (EXCLUSION_CONTEXT.test(lines[index])) return true;
  }
  return false;
}

function rank(confidence: CodeCandidate["confidence"]): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

export function extractCodes(input: {
  subject?: string;
  text: string;
  includeLow?: boolean;
}): CodeCandidate[] {
  const subject = normalize(input.subject ?? "");
  // 件名を1行目として本文と同じ走査に載せる（I-6）。件名にしかコードが無いメールを拾うため
  const text = redactExcluded(`${subject}\n${normalize(input.text)}`);
  const lines = text.split("\n");
  const hasOtpWord = OTP_WORD_PATTERN.test(text);
  const subjectHasLabel = LABEL_PATTERN.test(subject);
  const found = new Map<string, CodeCandidate>();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const matches = Array.from(line.matchAll(/(?<!\d)(\d{4,8})(?!\d)/g));
    for (const match of matches) {
      const value = match[1];
      const start = match.index ?? 0;
      const end = start + value.length;
      const previous = lines[lineIndex - 1] ?? "";
      const next = lines[lineIndex + 1] ?? "";
      const isIndependent = line.trim() === value;
      const sameLineLabel = LABEL_PATTERN.test(line);
      const adjacentLabel = LABEL_PATTERN.test(previous) || LABEL_PATTERN.test(next);
      // 隣接行・件名のラベルを根拠にできるのは「行全体が数字だけ」のときに限る（F-1）。
      // 散文中の数字は、ラベルが同じ行にあるときだけ候補にする
      const labelNear = sameLineLabel || (isIndependent && (adjacentLabel || subjectHasLabel));
      const excluded =
        lineHasExcludedNumberContext(line, start, end) || looksLikeOtherIdentifier(line, value, start, end);

      let candidate: CodeCandidate | null = null;
      if (labelNear && !excluded) {
        candidate = { value, confidence: "high", reason: "認証ラベルの近傍" };
      } else if (hasOtpWord && isIndependent && !excluded && !precededByExclusion(lines, lineIndex)) {
        candidate = { value, confidence: "medium", reason: "OTP文脈内の独立行" };
      } else if (input.includeLow && !labelNear && !excluded) {
        candidate = { value, confidence: "low", reason: "文脈のない4〜8桁" };
      }
      // 除外語・別種の識別子に当たった候補は捨てる。medium に落として画面へ残さない（I-1／FR-03「除外」）

      if (candidate) {
        const current = found.get(value);
        if (!current || rank(candidate.confidence) > rank(current.confidence)) found.set(value, candidate);
      }
    }
  }
  return dropYearsWhenOtherCandidatesExist(Array.from(found.values())).sort(
    (a, b) => rank(b.confidence) - rank(a.confidence),
  );
}

/** 「有効期限 2026」のような西暦は、ほかに候補があるなら落とす（F-1）。 */
function dropYearsWhenOtherCandidatesExist(candidates: CodeCandidate[]): CodeCandidate[] {
  const others = candidates.filter((candidate) => !YEAR_PATTERN.test(candidate.value));
  return others.length > 0 ? others : candidates;
}

const PRIORITY_PATTERN =
  /確認|認証|メールアドレスを確認|ログイン|verify|confirm|activate|magic|token|token_hash|oobCode|confirmation_code/i;
const EXCLUDED_LINK_PATTERN = /unsubscribe|privacy|preferences/i;

export function extractLinks(input: {
  text: string;
  htmlLinks?: { url: string; label: string }[];
}): LinkCandidate[] {
  const candidates = [
    ...(input.htmlLinks ?? []),
    ...Array.from(normalize(input.text).matchAll(/https?:\/\/[^\s<>"'）)]+/gi), (match) => ({
      url: match[0],
      label: "",
    })),
  ];
  const unique = new Map<string, LinkCandidate>();
  for (const candidate of candidates) {
    if (/^mailto:/i.test(candidate.url)) continue;
    try {
      const parsed = new URL(candidate.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const context = `${candidate.label} ${parsed.pathname} ${parsed.search}`;
      if (EXCLUDED_LINK_PATTERN.test(context)) continue;
      const priority = PRIORITY_PATTERN.test(context) ? 0 : 1;
      const normalizedUrl = parsed.toString();
      const existing = unique.get(normalizedUrl);
      if (!existing || priority < existing.priority || (!existing.label && candidate.label)) {
        unique.set(normalizedUrl, { host: parsed.hostname, url: normalizedUrl, label: candidate.label.trim(), priority });
      }
    } catch {
      // 不正なURLは表示しない。
    }
  }
  return Array.from(unique.values()).sort((a, b) => a.priority - b.priority);
}
