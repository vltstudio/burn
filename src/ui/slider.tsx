import { useEffect, useRef, useState } from "react";

interface SliderProps {
  value: number;
  max: number;
  onChange: (value: number) => void;
  className?: string;
  ariaLabel?: string;
}

function clampRatio(ratio: number) {
  return Math.min(Math.max(ratio, 0), 1);
}

export function Slider({ value, max, onChange, className, ariaLabel }: SliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The pointer that owns the drag: a press seeks at once, every move until
  // release keeps seeking, and moves after a release are ignored. It lives in
  // a ref so a move that lands before React re-renders is still applied.
  const pointerRef = useRef<number | null>(null);
  // The position the press asked for, shown until the caller reports a new
  // one, so the fill trails the pointer instead of waiting for playback.
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => setPending(null), [value]);

  const shown = pending ?? value;
  const ratio = max > 0 ? clampRatio(shown / max) : 0;

  const seekTo = (clientX: number) => {
    const element = trackRef.current;
    if (!element || max <= 0) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return;
    const next = clampRatio((clientX - rect.left) / rect.width) * max;
    setPending(next);
    onChange(next);
  };

  const endDrag = (pointerId: number) => {
    if (pointerRef.current !== pointerId) return;
    pointerRef.current = null;
    // The caller has the position by now; a caller that kept it just confirms
    // it, and one that refused it gets the fill back on the real position.
    setPending(null);
    const element = trackRef.current;
    if (element?.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  };

  return (
    <div
      ref={trackRef}
      className={`slider ${className ?? ""}`}
      role="slider"
      aria-label={ariaLabel}
      tabIndex={max > 0 ? 0 : -1}
      aria-disabled={max <= 0 || undefined}
      aria-valuemin={0}
      aria-valuenow={Math.round(shown)}
      aria-valuemax={Math.round(max)}
      onKeyDown={(event) => {
        if (max <= 0) return;
        let next: number;
        switch (event.key) {
          case "ArrowRight":
          case "ArrowUp": next = value + 5; break;
          case "ArrowLeft":
          case "ArrowDown": next = value - 5; break;
          case "Home": next = 0; break;
          case "End": next = max; break;
          default: return;
        }
        event.preventDefault();
        onChange(Math.min(Math.max(next, 0), max));
      }}
      onPointerDown={(event) => {
        if (max <= 0) return;
        // A mouse press only seeks with the primary button; touch and pen have
        // no middle or secondary button to filter out.
        if (event.pointerType === "mouse" && event.button !== 0) return;
        pointerRef.current = event.pointerId;
        trackRef.current?.setPointerCapture?.(event.pointerId);
        seekTo(event.clientX);
      }}
      onPointerMove={(event) => {
        if (pointerRef.current !== event.pointerId) return;
        seekTo(event.clientX);
      }}
      onPointerUp={(event) => endDrag(event.pointerId)}
      onPointerCancel={(event) => endDrag(event.pointerId)}
      onLostPointerCapture={() => {
        pointerRef.current = null;
      }}
    >
      <div className="slider-track">
        <div className="slider-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
