import { useRef, useState } from "react";

interface SliderProps {
  value: number;
  max: number;
  onChange: (value: number) => void;
  className?: string;
  ariaLabel?: string;
}

export function Slider({ value, max, onChange, className, ariaLabel }: SliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;

  const apply = (clientX: number) => {
    const element = trackRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0) return;
    const next = ((clientX - rect.left) / rect.width) * max;
    onChange(Math.min(Math.max(next, 0), max));
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
      aria-valuenow={Math.round(value)}
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
        if (max <= 0 || event.button !== 0) return;
        trackRef.current?.setPointerCapture(event.pointerId);
        setDragging(true);
        apply(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging) apply(event.clientX);
      }}
      onPointerUp={(event) => {
        if (trackRef.current?.hasPointerCapture(event.pointerId)) {
          trackRef.current.releasePointerCapture(event.pointerId);
        }
        setDragging(false);
      }}
      onLostPointerCapture={() => setDragging(false)}
    >
      <div className="slider-track">
        <div className="slider-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
