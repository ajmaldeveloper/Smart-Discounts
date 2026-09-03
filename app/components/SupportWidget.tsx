import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import "../styles/support-widget.css";

const SUPPORT_WHATSAPP_NUMBER = "923003093091";
const SUPPORT_EMAIL = "support@winsletapps.com";

function ChatIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none">
      <path
        d="M3 9.5c0-3.59 3.13-6.5 7-6.5s7 2.91 7 6.5-3.13 6.5-7 6.5c-.86 0-1.68-.14-2.44-.41L4 17l.98-3.13A6.2 6.2 0 0 1 3 9.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
      <path d="M10 2.5a7.47 7.47 0 0 0-6.42 11.3L2.5 17.5l3.8-1.03A7.47 7.47 0 1 0 10 2.5Zm0 1.35a6.1 6.1 0 0 1 5.06 9.53 6.1 6.1 0 0 1-9.63 1.28l-.22-.2-2.14.58.58-2.09-.2-.23A6.1 6.1 0 0 1 10 3.85Zm-2.5 2.8c-.15 0-.4.06-.6.29-.21.23-.8.78-.8 1.9 0 1.12.82 2.2.94 2.36.11.15 1.6 2.55 3.98 3.44 1.98.73 2.38.59 2.8.55.43-.04 1.4-.57 1.6-1.13.2-.55.2-1.03.14-1.13-.06-.1-.21-.16-.44-.28-.23-.11-1.4-.7-1.62-.78-.22-.08-.37-.11-.53.12-.15.23-.6.77-.74.93-.14.15-.27.17-.5.06-.23-.12-.98-.36-1.87-1.16-.69-.62-1.16-1.38-1.29-1.61-.14-.23-.01-.36.1-.47.11-.1.23-.27.35-.4.11-.14.15-.23.23-.38.08-.15.04-.29-.02-.4-.06-.12-.53-1.31-.74-1.79-.19-.46-.4-.4-.55-.4h-.44Z" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none">
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 5.5 10 11l6.5-5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Mirrors the Product Options app's "Get support" widget exactly (same
 * Winslet support inbox/WhatsApp line, same tawk.to placeholder wiring
 * in app.tsx). The chat card degrades to a toast pointing at
 * WhatsApp/email whenever tawk.to hasn't loaded — true right now since
 * TAWK_TO_PROPERTY_ID in app.tsx is still a placeholder, but also true
 * if Shopify's embedded-admin CSP or an ad blocker ever blocks the
 * script once a real id is set.
 */
export default function SupportWidget({ shop }: { shop: string }) {
  const shopify = useAppBridge();
  const [chatOnline, setChatOnline] = useState(false);

  useEffect(() => {
    const tawkApi = (
      window as typeof window & {
        Tawk_API?: {
          onStatusChange?: (callback: (status: string) => void) => void;
          getStatus?: () => string;
        };
      }
    ).Tawk_API;

    if (!tawkApi) return;

    if (tawkApi.getStatus) {
      setChatOnline(tawkApi.getStatus() === "online");
    }

    if (tawkApi.onStatusChange) {
      tawkApi.onStatusChange((status) => setChatOnline(status === "online"));
    }
  }, []);

  const whatsAppHref = `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(
    `Hi, I need help with Winslet Smart Discounts on ${shop}.`,
  )}`;

  const mailtoHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    `Support: Winslet Smart Discounts (${shop})`,
  )}`;

  const openSupportChat = () => {
    const tawkApi = (
      window as typeof window & {
        Tawk_API?: { toggle?: () => void; maximize?: () => void };
      }
    ).Tawk_API;

    if (tawkApi?.maximize) {
      tawkApi.maximize();
      return;
    }

    if (tawkApi?.toggle) {
      tawkApi.toggle();
      return;
    }

    shopify.toast.show(
      "Chat isn't available right now — use WhatsApp or email below.",
      { duration: 3200 },
    );
  };

  return (
    <s-section heading="Get support">
      <s-box padding="base" border="base" borderRadius="base">
        <p className="wsd-support-lede">
          Pick whichever is easiest. Your store URL is attached
          automatically, so we can look things up straight away.
        </p>

        <div className="wsd-support-cards">
          <button type="button" className="wsd-support-card" onClick={openSupportChat}>
            <span className="wsd-support-card-head">
              <span className="wsd-support-icon" aria-hidden="true">
                <ChatIcon />
              </span>
              <span className="wsd-support-title">Live chat</span>
              <span
                className={
                  chatOnline
                    ? "wsd-support-status-dot wsd-support-status-dot--online"
                    : "wsd-support-status-dot"
                }
                aria-hidden="true"
              />
            </span>
            <span className="wsd-support-card-detail">
              {chatOnline
                ? "Online — chat with us now"
                : "Away — leave a message and we reply by email"}
            </span>
          </button>

          <a className="wsd-support-card" href={whatsAppHref} target="_blank" rel="noreferrer">
            <span className="wsd-support-card-head">
              <span className="wsd-support-icon wsd-support-icon--whatsapp" aria-hidden="true">
                <WhatsAppIcon />
              </span>
              <span className="wsd-support-title">WhatsApp</span>
            </span>
            <span className="wsd-support-card-detail">Send a screenshot or voice note</span>
          </a>

          <a className="wsd-support-card" href={mailtoHref}>
            <span className="wsd-support-card-head">
              <span className="wsd-support-icon" aria-hidden="true">
                <EmailIcon />
              </span>
              <span className="wsd-support-title">Email</span>
              <span className="wsd-support-badge">Fastest right now</span>
            </span>
            <span className="wsd-support-card-detail">{SUPPORT_EMAIL}</span>
          </a>
        </div>

        <hr className="wsd-support-divider" />

        <p className="wsd-support-footer">
          Most questions are answered in the help docs.
        </p>
      </s-box>
    </s-section>
  );
}
