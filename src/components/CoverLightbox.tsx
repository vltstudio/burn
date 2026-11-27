import { useEffect } from "react";
import { Cover } from "../ui/cover";

interface Props {
  src?: string;
  title: string;
  onClose: () => void;
}

/** Full-window artwork view, opened from the player cover. Artwork only. */
export function CoverLightbox({ src, title, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <Cover className="lightbox-art" src={src} alt={title} />
    </div>
  );
}