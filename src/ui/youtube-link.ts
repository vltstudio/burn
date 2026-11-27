const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

export function youtubeVideoId(value: string): string | null {
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    return null;
  }

  let id: string | null | undefined;
  if (url.hostname === "youtu.be") {
    id = url.pathname.match(/^\/([^/]+)\/?$/)?.[1];
  } else if (youtubeHosts.has(url.hostname)) {
    id = /^\/watch\/?$/.test(url.pathname)
      ? url.searchParams.get("v")
      : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1];
  }
  return id && videoIdPattern.test(id) ? id : null;
}
