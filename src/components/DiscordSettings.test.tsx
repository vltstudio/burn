import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { useDiscordPresence } from "../discord-presence";
import { DiscordSettings } from "./DiscordSettings";

let host: HTMLDivElement;
let root: Root;
let props: ReturnType<typeof useDiscordPresence>;

const render = () => act(async () => root.render(<DiscordSettings {...props} />));
const toggle = (selector: string) => act(async () => {
  host.querySelector<HTMLInputElement>(selector)?.click();
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  props = {
    supported: true, preferences: { enabled: false, shareLocal: false },
    status: "idle", loadError: false, retry: vi.fn(), configure: vi.fn(async () => {}),
  };
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("enables sharing without any ID field and keeps local tracks private by default", async () => {
  await render();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Показ музыки выключен.");
  expect(host.querySelector('input:not([type="checkbox"])')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]:not([role])')?.disabled).toBe(true);
  expect(props.configure).not.toHaveBeenCalled();
  await toggle('[role="switch"]');
  expect(props.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true, shareLocal: false });
});

it("lets the user turn off sharing without losing the separate local preference", async () => {
  props.preferences = { enabled: true, shareLocal: true };
  props.status = "active";
  await render();
  expect(host.textContent).toContain("Discord получил текущий трек");
  await toggle('[role="switch"]');
  expect(props.configure).toHaveBeenCalledExactlyOnceWith({ ...props.preferences, enabled: false });
});
