import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Slider } from "./slider";

const TRACK_LEFT = 10;
const TRACK_WIDTH = 200;

describe("Slider", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    onChange.mockClear();
  });

  function render({ value = 30, max = 100 }: { value?: number; max?: number } = {}) {
    act(() => {
      root.render(<Slider value={value} max={max} onChange={onChange} ariaLabel="Позиция" />);
    });
    const slider = container.querySelector<HTMLDivElement>(".slider")!;
    slider.getBoundingClientRect = () => ({
      x: TRACK_LEFT, y: 0, left: TRACK_LEFT, top: 0,
      width: TRACK_WIDTH, height: 16, right: TRACK_LEFT + TRACK_WIDTH, bottom: 16,
      toJSON: () => ({}),
    }) as DOMRect;
    return slider;
  }

  function pointer(target: Element, type: string, clientX: number, init: PointerEventInit = {}) {
    act(() => {
      target.dispatchEvent(new PointerEvent(type, { clientX, pointerId: 1, bubbles: true, ...init }));
    });
  }

  const fillWidth = () => container.querySelector<HTMLDivElement>(".slider-fill")!.style.width;

  it("seeks at once on a single press, without any movement", () => {
    const slider = render();
    pointer(slider, "pointerdown", TRACK_LEFT + TRACK_WIDTH * 0.75);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(75);
  });

  it("maps a press on either edge to the ends of the track", () => {
    const slider = render();
    pointer(slider, "pointerdown", TRACK_LEFT - 40);
    expect(onChange).toHaveBeenLastCalledWith(0);
    pointer(slider, "pointerup", TRACK_LEFT - 40);
    pointer(slider, "pointerdown", TRACK_LEFT + TRACK_WIDTH + 40);
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it("keeps seeking while the pressed pointer moves and stops after release", () => {
    const slider = render();
    pointer(slider, "pointerdown", TRACK_LEFT + TRACK_WIDTH * 0.2);
    pointer(slider, "pointermove", TRACK_LEFT + TRACK_WIDTH * 0.5);
    pointer(slider, "pointermove", TRACK_LEFT + TRACK_WIDTH * 0.8);
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([20, 50, 80]);

    pointer(slider, "pointerup", TRACK_LEFT + TRACK_WIDTH * 0.8);
    pointer(slider, "pointermove", TRACK_LEFT + TRACK_WIDTH * 0.1);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("ignores hover movement and cancelled drags", () => {
    const slider = render();
    pointer(slider, "pointermove", TRACK_LEFT + TRACK_WIDTH * 0.5);
    expect(onChange).not.toHaveBeenCalled();

    pointer(slider, "pointerdown", TRACK_LEFT + TRACK_WIDTH * 0.5);
    pointer(slider, "pointercancel", TRACK_LEFT + TRACK_WIDTH * 0.5);
    pointer(slider, "pointermove", TRACK_LEFT + TRACK_WIDTH * 0.9);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(50);
  });

  it("leaves secondary mouse presses alone", () => {
    const slider = render();
    pointer(slider, "pointerdown", TRACK_LEFT + TRACK_WIDTH * 0.5, { pointerType: "mouse", button: 2 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cannot seek before the track has a length", () => {
    const slider = render({ value: 0, max: 0 });
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    pointer(slider, "pointerdown", TRACK_LEFT + TRACK_WIDTH * 0.5);
    expect(onChange).not.toHaveBeenCalled();
    expect(fillWidth()).toBe("0%");
  });

  it("follows the pressed position before the caller reports it back", () => {
    const slider = render({ value: 30 });
    expect(fillWidth()).toBe("30%");
    pointer(slider, "pointerdown", TRACK_LEFT + TRACK_WIDTH * 0.75);
    expect(fillWidth()).toBe("75%");
  });

  it("keeps the fill on the position the caller reports", () => {
    render({ value: 30 });
    expect(fillWidth()).toBe("30%");
    act(() => {
      root.render(<Slider value={62} max={100} onChange={onChange} ariaLabel="Позиция" />);
    });
    expect(fillWidth()).toBe("62%");
  });

  it("returns the fill to the real position when the caller refuses the seek", () => {
    const slider = render({ value: 30 });
    pointer(slider, "pointerdown", TRACK_LEFT + TRACK_WIDTH * 0.75);
    expect(fillWidth()).toBe("75%");
    pointer(slider, "pointerup", TRACK_LEFT + TRACK_WIDTH * 0.75);
    expect(fillWidth()).toBe("30%");
  });

  it("seeks by keyboard steps", () => {
    const slider = render({ value: 30, max: 100 });
    act(() => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(35);
    act(() => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(100);
    act(() => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});
