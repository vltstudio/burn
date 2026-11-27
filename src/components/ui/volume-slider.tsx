"use client";

import NumberFlow from "@number-flow/react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface VolumeSliderProps {
  /** Current volume, 0…1. */
  value: number;
  onChange: (value: number) => void;
  bars?: number;
  className?: string;
}

const PADDING = 12;

/**
 * Bar-graph volume control: the bars grow under the cursor, the filled part
 * follows the volume, and a number rides above the pointer.
 */
export default function VolumeSlider({ value, onChange, bars = 30, className }: VolumeSliderProps) {
  const [hoverValue, setHoverValue] = useState<number | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [containerWidth, setContainerWidth] = useState(200);
  const containerRef = useRef<HTMLDivElement>(null);

  const mouseX = useMotionValue(PADDING);
  const smoothMouseX = useSpring(mouseX, { damping: 20, stiffness: 300 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateWidth = () => setContainerWidth(element.offsetWidth);
    updateWidth();
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  useEffect(() => {
    const release = () => setIsDragging(false);
    window.addEventListener("pointerup", release);
    return () => window.removeEventListener("pointerup", release);
  }, []);

  const isActive = isHovering || isDragging;
  const progress = Math.min(Math.max(value, 0), 1);
  const displayValue = Math.round((hoverValue ?? value) * 100);

  const pointAt = (event: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  };

  const update = (event: React.PointerEvent, commit: boolean) => {
    const x = pointAt(event);
    mouseX.set(x);
    const innerWidth = Math.max(1, containerWidth - PADDING * 2);
    const next = Math.min(Math.max((x - PADDING) / innerWidth, 0), 1);
    setHoverValue(next);
    if (commit || isDragging) onChange(next);
  };

  const tooltipLeft = useTransform(smoothMouseX, [0, containerWidth], ["0%", "100%"]);

  return (
    <div className={cn("volume-slider", className)}>
      <AnimatePresence>
        {isActive ? (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.85 }}
            animate={{ opacity: 1, y: -34, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.85 }}
            transition={{ type: "spring", damping: 16, stiffness: 400 }}
            className="volume-tooltip"
            style={{ left: tooltipLeft, translateX: "-50%" }}
          >
            <NumberFlow value={displayValue} />
            <span className="volume-tooltip-unit">%</span>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div
        ref={containerRef}
        className={cn("volume-track", isActive ? "active" : "")}
        onPointerMove={(event) => update(event, false)}
        onPointerEnter={() => setIsHovering(true)}
        onPointerLeave={() => {
          setIsHovering(false);
          setHoverValue(null);
        }}
        onPointerDown={(event) => {
          setIsDragging(true);
          update(event, true);
        }}
      >
        <div className="volume-bars">
          {Array.from({ length: bars }).map((_, index) => (
            <Bar
              key={index}
              index={index}
              mouseX={smoothMouseX}
              bars={bars}
              progress={progress}
              isActive={isActive}
              containerWidth={containerWidth}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Bar({
  index,
  mouseX,
  bars,
  progress,
  isActive,
  containerWidth,
}: {
  index: number;
  mouseX: MotionValue<number>;
  bars: number;
  progress: number;
  isActive: boolean;
  containerWidth: number;
}) {
  const barProgress = index / (bars - 1);
  const isFilled = barProgress <= progress;

  const height = useTransform(mouseX, (value: number) => {
    const idleHeight = 7;
    const hoverBaseHeight = 34;
    const dipHeight = 13;

    if (!isActive) return idleHeight;

    const innerWidth = containerWidth - PADDING * 2;
    const barX = PADDING + barProgress * innerWidth;
    const distance = Math.abs(value - barX);
    const maxDistance = 96;

    let targetHeight = hoverBaseHeight;

    if (distance < maxDistance) {
      const relDist = distance / maxDistance;
      const dip = (Math.cos(relDist * Math.PI) + 1) / 2;
      targetHeight = hoverBaseHeight - dip * (hoverBaseHeight - dipHeight);
    }

    if (isFilled) {
      const activeRangeProgress = barProgress / Math.max(progress, 0.01);
      targetHeight += Math.sin(activeRangeProgress * Math.PI) * 5;
    }

    return targetHeight;
  });

  const smoothHeight = useSpring(height, { damping: 35, stiffness: 300 });

  return <motion.div style={{ height: smoothHeight }} className={cn("volume-bar", isFilled && "filled")} />;
}