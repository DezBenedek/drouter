import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type InputHTMLAttributes,
} from "react";
import { Eye, EyeOff, X, Search, ArrowLeft } from "lucide-react";
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M3 7h5c5 0 3 10 8 10h5M3 17h5c5 0 3-10 8-10h5" />
          <path d="m18 4 3 3-3 3m0 4 3 3-3 3" />
        </svg>
      </span>
      DRouter
    </div>
  );
}
export function Button({
  children,
  variant = "",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button type="button" className={`${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="field">
      {label}
      <input {...props} />
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Password({
  label = "Password",
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      {label}
      <span className="password-control">
        <input {...props} type={visible ? "text" : "password"} />
        <button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </button>
      </span>
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`search-field ${className}`}>
      <span className="sr-only">{label}</span>
      <Search />
      <input
        type="search"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || label}
      />
    </label>
  );
}
export function Status({
  online,
  children,
}: {
  online: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`status-text ${online ? "live" : ""}`}>
      <span className={`status-dot ${online ? "" : "offline"}`} />
      {children}
    </span>
  );
}
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
export function Modal({
  title,
  description,
  children,
  footer,
  onClose,
  source = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  source?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const d = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    d.showModal();
    return () => {
      d.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${source ? "source-dialog" : ""}`}
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close.current();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close.current();
      }}
    >
      <header className="dialog-header">
        {source && (
          <Button
            variant="quiet icon-button mobile-only"
            aria-label="Back to outputs"
            onClick={onClose}
          >
            <ArrowLeft />
          </Button>
        )}
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <Button
          variant="quiet icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="dialog-body">{children}</div>
      {footer && <footer className="dialog-footer">{footer}</footer>}
    </dialog>
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function SettingRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-copy">
        {title}
        {detail && <span>{detail}</span>}
      </div>
      {children}
    </div>
  );
}
