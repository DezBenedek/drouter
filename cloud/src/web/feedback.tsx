import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Toaster, toast as sonner } from "sonner";
import "sonner/dist/styles.css";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { setToastAdapter } from "../../../firmware/web/shared/control.js";
import { t } from "../../../firmware/web/shared/i18n.js";

// Shared workflows call the same API in both browsers. React uses Sonner;
// the embedded controller retains the small, framework-free implementation.
setToastAdapter({
  show(message: string, kind: string, id: string) {
    return sonner.custom(
      (key) => (
        <div
          className="toast"
          data-kind={kind}
          role={kind === "error" ? "alert" : "status"}
          aria-atomic="true"
        >
          <span className="toast-icon" aria-hidden="true">
            {kind === "loading" ? (
              <span className="spinner" />
            ) : kind === "success" ? (
              <CheckCircle2 />
            ) : kind === "error" ? (
              <CircleAlert />
            ) : (
              <Info />
            )}
          </span>
          <div className="toast-copy">{t(message)}</div>
          <button
            type="button"
            className="toast-close"
            aria-label={t("Dismiss notification")}
            onClick={() => sonner.dismiss(key)}
          >
            <X />
          </button>
        </div>
      ),
      {
        id: id || undefined,
        duration:
          kind === "loading" ? Infinity : kind === "error" ? 10000 : 4500,
      },
    );
  },
  dismiss(id: string) {
    sonner.dismiss(id || undefined);
  },
});

export function Feedback() {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "feedback-layer";
    element.setAttribute("popover", "manual");
    return element;
  });
  useEffect(() => {
    const place = () => {
      const target =
        [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(
          -1,
        ) || document.body;
      if (host.parentElement !== target) {
        if (host.matches(":popover-open")) host.hidePopover();
        target.appendChild(host);
      }
      const mobile = matchMedia("(max-width: 899px)").matches;
      const menu =
        mobile && target === document.body
          ? document.querySelector(".more-menu")?.getBoundingClientRect()
          : null;
      host.style.setProperty(
        "--feedback-bottom",
        menu?.height
          ? `${innerHeight - menu.top + 12}px`
          : mobile && document.querySelector(".app-nav")
            ? "calc(84px + env(safe-area-inset-bottom))"
            : "24px",
      );
      if (!host.matches(":popover-open")) host.showPopover();
    };
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (r) =>
            (r.target as Element).tagName === "DIALOG" ||
            (r.target as Element).classList?.contains("more-menu") ||
            [...r.addedNodes, ...r.removedNodes].some(
              (node) =>
                node instanceof Element &&
                node.matches(".app-shell,.more-menu,.app-nav,dialog"),
            ),
        )
      )
        place();
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: ["open", "hidden"],
    });
    window.addEventListener("resize", place);
    document.addEventListener("close", place, true);
    place();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("close", place, true);
      host.remove();
    };
  }, [host]);
  return createPortal(
    <Toaster
      position="bottom-left"
      visibleToasts={3}
      gap={10}
      offset={{ bottom: "var(--feedback-bottom)", left: 24, right: 24 }}
      mobileOffset={{ bottom: "var(--feedback-bottom)", left: 12, right: 12 }}
      containerAriaLabel={t("Notifications")}
      swipeDirections={["left", "right", "bottom"]}
    />,
    host,
  );
}
