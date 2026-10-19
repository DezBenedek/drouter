import { remoteName, hex } from "./auth";
import { registry, type DeviceRecord } from "./registry";
export { DeviceRegistry } from "./registry";
export { RouterRelay } from "./durable-object";
export interface Env {
  ROUTERS: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  ASSETS: Fetcher;
  DEV_ORIGIN?: string;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/relay/")) {
      const match = /^\/relay\/([^/]+)\/(device|browser)$/.exec(url.pathname);
      if (
        !match ||
        !(match[2] === "device"
          ? /^[a-f0-9]{64}$/.test(match[1])
          : remoteName.test(match[1]))
      )
        return new Response("Unavailable", { status: 404 });
      const origin = request.headers.get("Origin");
      if (
        match[2] === "browser" &&
        origin !== url.origin &&
        !(url.hostname === "127.0.0.1" && origin === env.DEV_ORIGIN)
      )
        return new Response("Unavailable", { status: 403 });
      let deviceId = match[1];
      if (match[2] === "browser") {
        const lookup = await registry(env).fetch(
          `https://registry.internal/lookup?name=${match[1]}`,
        );
        const record = (await lookup.json()) as DeviceRecord | null;
        deviceId =
          record?.device_id ||
          hex(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(`absent:${match[1]}`),
            ),
          );
      }
      const internal = new URL(request.url);
      internal.pathname = `/relay/${deviceId}/${match[2]}`;
      const headers = new Headers(request.headers);
      headers.set("X-DRouter-Name", match[1]);
      return env.ROUTERS.get(env.ROUTERS.idFromName(deviceId)).fetch(
        new Request(internal, { method: request.method, headers }),
      );
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
