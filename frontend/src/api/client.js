const BASE = "";

function readableError(data, fallback) {
  if (data == null) return fallback;
  const detail = data.detail ?? data.error?.message ?? data.message;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      const where = Array.isArray(item.loc) ? item.loc.filter((p) => p !== "body").join(".") : "";
      const msg = item.msg || JSON.stringify(item);
      return where ? `${where}: ${msg}` : msg;
    });
    if (parts.length) return parts.join("; ");
  }
  if (typeof detail === "object" && detail !== null) {
    const text = JSON.stringify(detail);
    if (text !== "{}") return text;
  }
  try {
    const text = JSON.stringify(data);
    return text === "{}" ? fallback : text;
  } catch {
    return fallback;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const fallback = response.statusText || `Request failed (${response.status})`;
    let message = fallback;
    try {
      message = readableError(await response.json(), fallback);
    } catch {
      /* non-JSON body - keep fallback */
    }
    throw new Error(message);
  }
  return response.json();
}

export const api = {
  listChannels: () => request("/api/channels"),
  createChannel: (body) => request("/api/channels", { method: "POST", body: JSON.stringify(body) }),
  updateChannel: (id, body) =>
    request(`/api/channels/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteChannel: (id) => request(`/api/channels/${id}`, { method: "DELETE" }),

  listAssets: (channelId) => request(`/api/channels/${channelId}/assets`),
  uploadAsset: (channelId, file) => {
    const form = new FormData();
    form.append("file", file);
    return request(`/api/channels/${channelId}/assets`, { method: "POST", body: form });
  },
  deleteAsset: (assetId) => request(`/api/assets/${assetId}`, { method: "DELETE" }),

  generate: (channelId, body) =>
    request(`/api/channels/${channelId}/generate`, { method: "POST", body: JSON.stringify(body) }),
  generateBatch: (channelId, body) =>
    request(`/api/channels/${channelId}/generate/batch`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  regenerate: (id, body = {}) =>
    request(`/api/generations/${id}/regenerate`, { method: "POST", body: JSON.stringify(body) }),
  patchGeneration: (id, body) =>
    request(`/api/generations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteGeneration: (id) => request(`/api/generations/${id}`, { method: "DELETE" }),
  listTemplates: (channelId) => request(`/api/channels/${channelId}/templates`),
  createTemplate: (channelId, body) =>
    request(`/api/channels/${channelId}/templates`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteTemplate: (id) => request(`/api/templates/${id}`, { method: "DELETE" }),
  exportChannelUrl: (channelId) => `/api/channels/${channelId}/export`,
  renameGeneration: (id, name) =>
    request(`/api/generations/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  saveGenerationAsAsset: (id, channelId) =>
    request(`/api/generations/${id}/save-as-asset`, {
      method: "POST",
      body: JSON.stringify({ channel_id: channelId }),
    }),
  upscaleGeneration: (id, scale = 2) =>
    request(`/api/generations/${id}/upscale`, {
      method: "POST",
      body: JSON.stringify({ scale }),
    }),
  upscaleAsset: (id, scale = 2) =>
    request(`/api/assets/${id}/upscale`, { method: "POST", body: JSON.stringify({ scale }) }),
  upscaleStatus: () => request("/api/upscale/status"),
  listGenerations: (params = {}) => {
    const search = new URLSearchParams();
    if (params.channelId != null) search.set("channel_id", params.channelId);
    if (params.search) search.set("search", params.search);
    if (params.dateFrom) search.set("date_from", params.dateFrom);
    if (params.dateTo) search.set("date_to", params.dateTo);
    if (params.hidden) search.set("hidden", params.hidden);
    if (params.category) search.set("category", params.category);
    if (params.limit) search.set("limit", params.limit);
    if (params.offset) search.set("offset", params.offset);
    const query = search.toString();
    return request(`/api/generations${query ? `?${query}` : ""}`);
  },
  spendSummary: (params = {}) => {
    const search = new URLSearchParams();
    if (params.channelId != null) search.set("channel_id", params.channelId);
    if (params.dateFrom) search.set("date_from", params.dateFrom);
    if (params.dateTo) search.set("date_to", params.dateTo);
    const query = search.toString();
    return request(`/api/spend${query ? `?${query}` : ""}`);
  },
  getGeneration: (id) => request(`/api/generations/${id}`),
};
