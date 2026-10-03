declare module "*.eml?raw" {
  const content: string;
  export default content;
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    INBOX: KVNamespace;
    ASSETS: Fetcher;
    MAIL_DOMAIN: string;
    APP_ORIGIN: string;
    ADDRESS_TTL_SECONDS: string;
    MESSAGE_TTL_SECONDS: string;
    ISSUE_LIMIT_PER_HOUR: string;
    MAX_RAW_BYTES: string;
    IP_HASH_SECRET: string;
    DEV_INJECT?: string;
    // 任意の秘密。テストの既定 env には入れず、必要なテストが env を差し替えて使う
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
  }
}
