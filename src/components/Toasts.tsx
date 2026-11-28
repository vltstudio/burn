export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
}

export function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
