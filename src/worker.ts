import { handleApi } from "./handlers/api";
import { handleEmail } from "./handlers/email";
import { withSecurityHeaders } from "./lib/headers";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handleApi(request, env);
    if (response) return response;
    // 静的アセットは Worker を通してから返す。CSP はここで載せる（I-7）＝`public/_headers` は持たない。
    // そのため `wrangler.jsonc` の `assets.run_worker_first` は true にしてある
    return withSecurityHeaders(await env.ASSETS.fetch(request), env);
  },
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
