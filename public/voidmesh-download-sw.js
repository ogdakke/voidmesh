const sessions = new Map();
const pendingSessionWaiters = new Map();

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;

  if (message.type === "ping") {
    event.ports[0]?.postMessage({ type: "pong" });
    return;
  }

  if (message.type === "open") {
    const port = event.ports[0];
    if (!port || typeof message.token !== "string") return;
    const session = {
      controller: null,
      filename: typeof message.filename === "string" ? message.filename : "workspace.vdmsh",
      pending: [],
      port,
    };
    sessions.set(message.token, session);
    const waiters = pendingSessionWaiters.get(message.token);
    if (waiters) {
      pendingSessionWaiters.delete(message.token);
      for (const resolve of waiters) resolve(session);
    }
    port.onmessage = (portEvent) => handlePortMessage(session, message.token, portEvent.data);
    port.start();
    return;
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/__voidmesh-download/")) return;

  const token = decodeURIComponent(url.pathname.slice("/__voidmesh-download/".length));
  event.respondWith(createDownloadResponse(token));
});

async function createDownloadResponse(token) {
  const session = await waitForSession(token);
  if (!session) return new Response("Download session not found", { status: 404 });

  return new Response(
    new ReadableStream({
      start(controller) {
        session.controller = controller;
        for (const message of session.pending.splice(0)) {
          handlePortMessage(session, token, message);
        }
        session.port.postMessage({ type: "ready" });
      },
      cancel() {
        session.port.postMessage({ type: "cancel" });
        sessions.delete(token);
      },
    }),
    {
      headers: {
        "Content-Type": "application/vnd.vdmsh",
        "Content-Disposition": `attachment; filename="${sanitizeFilename(session.filename)}"`,
        "Cache-Control": "no-store",
      },
    },
  );
}

function waitForSession(token) {
  const existing = sessions.get(token);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const waiters = pendingSessionWaiters.get(token) ?? [];
    waiters.push(resolve);
    pendingSessionWaiters.set(token, waiters);
    setTimeout(() => {
      const current = pendingSessionWaiters.get(token);
      if (!current) return;
      const index = current.indexOf(resolve);
      if (index !== -1) current.splice(index, 1);
      if (current.length === 0) pendingSessionWaiters.delete(token);
      resolve(null);
    }, 10_000);
  });
}

function handlePortMessage(session, token, message) {
  if (!message) return;
  if (!session.controller) {
    session.pending.push(message);
    return;
  }

  try {
    if (message.type === "chunk") {
      session.controller.enqueue(new Uint8Array(message.chunk));
      session.port.postMessage({ type: "ack" });
    } else if (message.type === "complete") {
      session.controller.close();
      session.port.postMessage({ type: "closed" });
      sessions.delete(token);
    } else if (message.type === "error") {
      session.controller.error(new Error(String(message.message ?? "Download failed")));
      sessions.delete(token);
    }
  } catch (error) {
    session.controller.error(error);
    sessions.delete(token);
  }
}

function sanitizeFilename(filename) {
  return filename.replace(/[\\"\r\n]/g, "_");
}
