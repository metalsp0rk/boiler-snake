/**
 * Hover/focus card for [data-user-card] chips. Same contract as public/app.js:
 * the attribute is the JSON URL, avatars render only for the Discord CDN,
 * and every string is textContent. Role border color is per-row data, so it
 * is the one inline style (the console style-src already allows it).
 */
import { isDiscordCdnAvatar } from "./avatar-url.mjs";

const CARD_HOVER_MS = 300;
const CARD_HIDE_MS = 150;

/**
 * @param {Document} doc
 */
export function installUserCard(doc) {
  const view = doc.defaultView || globalThis;
  let cardEl = null;
  let cardShowTimer = null;
  let cardHideTimer = null;
  const cardCache = Object.create(null);
  let cardSeq = 0;

  function ensureCard() {
    if (cardEl) return cardEl;
    cardEl = doc.createElement("div");
    cardEl.className = "bs-user-card is-floating";
    cardEl.setAttribute("role", "tooltip");
    cardEl.hidden = true;
    doc.body.appendChild(cardEl);
    cardEl.addEventListener("mouseenter", () => {
      if (cardHideTimer) {
        clearTimeout(cardHideTimer);
        cardHideTimer = null;
      }
    });
    cardEl.addEventListener("mouseleave", hideCardSoon);
    return cardEl;
  }

  function hideCardSoon() {
    if (cardHideTimer) clearTimeout(cardHideTimer);
    cardHideTimer = setTimeout(() => {
      if (cardEl) cardEl.hidden = true;
    }, CARD_HIDE_MS);
  }

  function renderCard(rect, data) {
    const el = ensureCard();
    while (el.firstChild) el.removeChild(el.firstChild);
    const head = doc.createElement("div");
    head.className = "bs-user-card-head";
    if (isDiscordCdnAvatar(data.avatar)) {
      const img = doc.createElement("img");
      img.className = "bs-user-card-avatar";
      img.src = String(data.avatar);
      img.alt = "";
      img.width = 48;
      img.height = 48;
      head.appendChild(img);
    }
    const who = doc.createElement("div");
    const nm = doc.createElement("div");
    nm.className = "bs-user-card-name";
    nm.textContent = data.name || data.tag || "(name unknown yet)";
    const idc = doc.createElement("div");
    idc.className = "bs-user-card-id bs-id";
    idc.textContent = String(data.id);
    who.appendChild(nm);
    who.appendChild(idc);
    head.appendChild(who);
    el.appendChild(head);
    if (Array.isArray(data.roles) && data.roles.length) {
      const roles = doc.createElement("div");
      roles.className = "bs-user-card-roles";
      data.roles.slice(0, 12).forEach((role) => {
        const chip = doc.createElement("span");
        chip.className = "bs-user-card-role";
        chip.textContent = String(role.name || "");
        if (role.color && /^#[0-9a-fA-F]{6}$/.test(String(role.color))) {
          chip.style.borderColor = String(role.color);
        }
        roles.appendChild(chip);
      });
      if (data.roles.length > 12) {
        const more = doc.createElement("span");
        more.className = "bs-user-card-role";
        more.textContent = `+${data.roles.length - 12}`;
        roles.appendChild(more);
      }
      el.appendChild(roles);
    }
    if (!data.known) {
      const warm = doc.createElement("div");
      warm.className = "bs-user-card-warm";
      warm.textContent = "not cached yet — details fill in shortly";
      el.appendChild(warm);
    }
    const width = 260;
    const left = Math.max(8, Math.min(view.innerWidth - width - 8, rect.left));
    el.style.left = `${left}px`;
    el.style.top = `${rect.bottom + 6}px`;
    el.style.width = `${width}px`;
    el.hidden = false;
  }

  function openCard(chip) {
    const url = chip.getAttribute("data-user-card");
    if (!url) return;
    const rect = chip.getBoundingClientRect();
    const hit = cardCache[url];
    if (hit) {
      renderCard(rect, hit);
      return;
    }
    const seq = ++cardSeq;
    fetch(url, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !data.id) return;
        cardCache[url] = data;
        if (seq === cardSeq) renderCard(rect, data);
      })
      .catch(() => {});
  }

  doc.addEventListener("mouseover", (evt) => {
    const el = evt.target && evt.target.closest ? evt.target.closest("[data-user-card]") : null;
    if (!el) return;
    if (cardEl && !cardEl.hidden && cardEl._openFor === el) return;
    if (cardShowTimer) clearTimeout(cardShowTimer);
    cardShowTimer = setTimeout(() => {
      cardSeq += 1;
      const card = ensureCard();
      card._openFor = el;
      openCard(el);
    }, CARD_HOVER_MS);
  });

  doc.addEventListener("mouseout", (evt) => {
    const el = evt.target && evt.target.closest ? evt.target.closest("[data-user-card]") : null;
    if (!el) return;
    if (evt.relatedTarget && el.contains(evt.relatedTarget)) return;
    if (cardShowTimer) {
      clearTimeout(cardShowTimer);
      cardShowTimer = null;
    }
    hideCardSoon();
  });

  doc.addEventListener("focusin", (evt) => {
    const el = evt.target && evt.target.closest ? evt.target.closest("[data-user-card]") : null;
    if (!el) return;
    if (cardShowTimer) {
      clearTimeout(cardShowTimer);
      cardShowTimer = null;
    }
    cardSeq += 1;
    const card = ensureCard();
    card._openFor = el;
    openCard(el);
  });

  doc.addEventListener("focusout", (evt) => {
    const el = evt.target && evt.target.closest ? evt.target.closest("[data-user-card]") : null;
    if (!el) return;
    if (evt.relatedTarget && el.contains(evt.relatedTarget)) return;
    if (cardShowTimer) {
      clearTimeout(cardShowTimer);
      cardShowTimer = null;
    }
    hideCardSoon();
  });

  doc.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && cardEl) cardEl.hidden = true;
  });

  view.addEventListener(
    "scroll",
    () => {
      if (cardEl) cardEl.hidden = true;
    },
    { passive: true, capture: true }
  );
}
