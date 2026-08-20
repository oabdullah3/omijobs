export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function parse(res) {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch { /* keep status text */ }
    throw new ApiError(res.status, msg);
  }
  return res.json();
}

export const api = {
  get: (path) => fetch(path).then(parse),
  post: (path, body = {}) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(parse),
  patch: (path, body = {}) =>
    fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(parse),
  put: (path, body = {}) =>
    fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(parse),
  onLive: (cb) => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const { type, payload } = JSON.parse(e.data);
        cb(type, payload);
      } catch { /* ignore malformed */ }
    };
    return es;
  },
};
