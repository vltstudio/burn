import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface BackdropApi {
  /** The artwork currently painting the window header, if any. */
  image: string | null;
  setBackdrop: (image: string | null) => void;
}

const BackdropContext = createContext<BackdropApi | null>(null);

export function useBackdrop(): BackdropApi {
  const value = useContext(BackdropContext);
  if (!value) throw new Error("useBackdrop must be used inside BackdropProvider");
  return value;
}

export function BackdropProvider({ children }: { children: ReactNode }) {
  const [image, setImage] = useState<string | null>(null);
  const setBackdrop = useCallback((next: string | null) => setImage(next), []);
  const value = useMemo<BackdropApi>(() => ({ image, setBackdrop }), [image, setBackdrop]);
  return <BackdropContext.Provider value={value}>{children}</BackdropContext.Provider>;
}
/** The window-wide artwork wash behind the header. */
export function BackdropWash() {
  const { image } = useBackdrop();
  return (
    <div
      className={`wash ${image ? "on" : ""}`}
      style={image ? { backgroundImage: `url("${image.replace(/"/g, "")}")` } : undefined}
      aria-hidden
    />
  );
}
