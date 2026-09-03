import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
// Side-effect only: starts the auto-publish interval once when the server process boots.
import "./services/scheduled-publish.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);

  // app.tsx's own ErrorBoundary already redirects a 404 to /app, but
  // only client-side (via useEffect) — the very FIRST full-page load of
  // a bad URL (a fresh tab, a stale bookmark, not a client-side
  // transition inside an already-hydrated app) never runs that effect,
  // so the browser would otherwise sit on a blank 404 document until JS
  // hydrates. Converting it into a real HTTP redirect here happens
  // before any rendering, so there's no flash at all. Scoped to /app/*
  // only — webhooks/auth/health have their own real meaning for a 404
  // and must never be redirected.
  if (responseStatusCode === 404 && new URL(request.url).pathname.startsWith("/app")) {
    return new Response(null, { status: 302, headers: { Location: "/app" } });
  }


  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
