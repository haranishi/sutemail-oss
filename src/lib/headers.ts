import { isTurnstileEnabled } from "./env";
import type { Env } from "../types";

/** Turnstile のウィジェットが読み込む唯一の外部オリジン。 */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * CSP を Worker 側で組み立てる（I-7）。
 *
 * 以前は `public/_headers` に2本書いて、Turnstile を有効にするときに人が差し替えていた。
 * 差し替えを忘れるとウィジェットの script が CSP で落ち、トークンが永久に空＝発行が全部 403 になる。
 * 「秘密鍵を入れたら CSP も変わる」を人の手から外すため、鍵の有無からここで決める。
 */
export function buildContentSecurityPolicy(turnstileEnabled: boolean): string {
  const turnstile = turnstileEnabled ? ` ${TURNSTILE_ORIGIN}` : "";
  const directives = [
    "default-src 'self'",
    `script-src 'self'${turnstile}`,
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self'${turnstile}`,
    ...(turnstileEnabled ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ];
  return directives.join("; ");
}

/** 本文を持てない応答。ヘッダーだけ差し替えるときに body を渡すと例外になる。 */
function isBodyless(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

/**
 * 静的アセットの応答へ CSP・nosniff・Referrer-Policy を載せる。
 * `env.ASSETS.fetch()` の結果をそのまま返さず、必ずここを通す。
 */
export function withSecurityHeaders(response: Response, env: Env): Response {
  const next = new Response(isBodyless(response.status) ? null : response.body, response);
  next.headers.set("Content-Security-Policy", buildContentSecurityPolicy(isTurnstileEnabled(env)));
  next.headers.set("X-Content-Type-Options", "nosniff");
  next.headers.set("Referrer-Policy", "no-referrer");
  return next;
}
