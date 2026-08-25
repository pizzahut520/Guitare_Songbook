export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  ASSETS: Fetcher;
  DEEPSEEK_API_KEY?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store"
    }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/api/health") {
      return jsonResponse({
        status: "ok",
        deepseek_configured: Boolean(env.DEEPSEEK_API_KEY)
      });
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return jsonResponse(
        {
          status: "not_implemented"
        },
        501
      );
    }

    return env.ASSETS.fetch(request);
  }
};
