export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
}

export function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="toasts">
      {items.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
