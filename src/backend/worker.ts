import app from "./index"
import { OpenListDB } from "./durable-objects/OpenListDB"
import { getOAuthPage } from "./oauth-pages"

// Durable Object 类（DB_DRIVER=do 时使用），需在 wrangler.toml 声明
// new_sqlite_classes = ["OpenListDB"] 与对应的 binding。
export { OpenListDB }

export default {
  fetch(request: Request, env: any, ctx: any) {
    const page = getOAuthPage(new URL(request.url).pathname)
    if (page && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : page, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
        },
      })
    }
    return app.fetch(request, env, ctx)
  },
}
