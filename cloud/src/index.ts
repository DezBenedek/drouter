import { remoteName } from "./auth";
export { RouterRelay } from "./durable-object";
export interface Env {
  ROUTERS: DurableObjectNamespace;
  ASSETS: Fetcher;
  DEV_ORIGIN?: string;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/relay/")) {
      const match = /^\/relay\/([^/]+)\/(device|browser)$/.exec(url.pathname);
      if (!match || !remoteName.test(match[1]))
        return new Response("Unavailable", { status: 404 });
      const origin = request.headers.get("Origin");
      if (
        match[2] === "browser" &&
        origin !== url.origin &&
        !(url.hostname === "127.0.0.1" && origin === env.DEV_ORIGIN)
      )
        return new Response("Unavailable", { status: 403 });
      const id = env.ROUTERS.idFromName(match[1]);
      return env.ROUTERS.get(id).fetch(request);
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  },
};
