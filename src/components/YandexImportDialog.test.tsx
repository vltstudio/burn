import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YandexImportDialog } from "./YandexImportDialog";
import type { YandexImportResult, YandexPreview, YandexProgress } from "../yandex";

const native = vi.hoisted(() => ({
  preview: vi.fn(),
  import: vi.fn(),
  cancel: vi.fn(),
  open: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    yandexPreview: native.preview,
    yandexImport: native.import,
    yandexImportCancel: native.cancel,
    openUrl: native.open,
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

const preview: YandexPreview = {
  warnings: ["history.json: не файл коллекции."],
  collections: [
    {
      id: "likes",
      name: "Мне нравится — Яндекс Музыка",
      tracks: [{ title: "Песня", artists: ["Группа"], seconds: 252 }],
      skipped: 1,
    },
    { id: "empty", name: "Пустой список", tracks: [], skipped: 2 },
    {
      id: "playlist",
      name: "В дороге",
      tracks: [{ title: "Track", artists: ["Artist"], seconds: null }],
      skipped: 0,
    },
  ],
};

describe("Yandex Music archive import", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onImported: ReturnType<typeof vi.fn<() => void>>;

  function button(prefix: string): HTMLButtonElement {
    const result = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.trim().startsWith(prefix));
    if (!result) throw new Error(`Button not found: ${prefix}`);
    return result;
  }

  async function choose() {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const selection = new DataTransfer();
    selection.items.add(new File(["[]"], "likes.json", { type: "application/json" }));
    input.files = selection.files;
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    native.preview.mockReset().mockResolvedValue(preview);
    native.import.mockReset();
    native.cancel.mockReset().mockResolvedValue(true);
    native.open.mockReset().mockResolvedValue(undefined);
    native.listen.mockReset().mockResolvedValue(native.unlisten);
    onImported = vi.fn<() => void>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<YandexImportDialog open onClose={vi.fn()} onImported={onImported} />); });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  it("previews without writing and imports only explicitly selected collections", async () => {
    native.import.mockResolvedValue([{
      id: "likes",
      name: preview.collections[0].name,
      skipped: 1,
      report: {
        playlistId: "PL42", title: preview.collections[0].name, total: 1, added: 1,
        unmatched: [], cover: false, coverError: null,
      },
      error: null,
    }] satisfies YandexImportResult[]);
    await choose();
    expect(native.preview).toHaveBeenCalledExactlyOnceWith([{ name: "likes.json", text: "[]" }]);
    expect(native.import).not.toHaveBeenCalled();
    expect(button("Импортировать").disabled).toBe(true);
    const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checks[1].disabled).toBe(true);
    await act(async () => { checks[0].click(); });
    await act(async () => { button("Импортировать").click(); });
    expect(native.import).toHaveBeenCalledExactlyOnceWith([preview.collections[0]], expect.any(String));
    expect(host.textContent).toContain("Добавлено 1 из 2 треков");
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("scopes progress and cancellation to the active request and displays partial failures", async () => {
    let finish!: (results: YandexImportResult[]) => void;
    native.import.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await choose();
    await act(async () => { button("Выбрать все").click(); });
    await act(async () => { button("Импортировать").click(); });
    const [, requestId] = native.import.mock.calls[0];
    const onProgress = native.listen.mock.calls[0][1] as (event: { payload: YandexProgress }) => void;
    const update: YandexProgress = {
      requestId: "unrelated", stage: "match", done: 1, total: 3, message: null, playlistId: null,
      collectionName: "В дороге", collectionIndex: 2, collectionTotal: 2,
    };
    await act(async () => { onProgress({ payload: update }); });
    expect(host.querySelector("progress")).toBeNull();
    await act(async () => { onProgress({ payload: { ...update, requestId } }); });
    expect(host.querySelector("progress")?.value).toBe(1);
    await act(async () => { button("Остановить").click(); });
    expect(native.cancel).toHaveBeenCalledExactlyOnceWith(requestId);
    await act(async () => { finish([{ id: "playlist", name: "В дороге", skipped: 0, error: "Импорт остановлен.", report: null }]); });
    expect(host.textContent).toContain("Импорт остановлен.");
    expect(native.unlisten).toHaveBeenCalledOnce();
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("opens only the fixed official Yandex archive and help pages", async () => {
    await act(async () => { button("Открыть Яндекс ID").click(); button("Инструкция Яндекса").click(); });
    expect(native.open.mock.calls).toEqual([
      ["https://id.yandex.ru/personal/data"],
      ["https://yandex.ru/support/id/ru/data"],
    ]);
  });
});
