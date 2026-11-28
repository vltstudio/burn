const changes = new EventTarget();

export function playlistChanged(id: string) {
  changes.dispatchEvent(new CustomEvent("change", { detail: id.replace(/^VL/, "") }));
}

export function onPlaylistChange(listener: (id: string) => void) {
  const notify = (event: Event) => listener((event as CustomEvent<string>).detail);
  changes.addEventListener("change", notify);
  return () => changes.removeEventListener("change", notify);
}
