let container: HTMLElement | null = null;

export function toast(text: string, kind: "info" | "warn" = "info") {
  if (!container) {
    container = document.getElementById("toasts");
  }
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast${kind === "warn" ? " warn" : ""}`;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("bye");
    setTimeout(() => el.remove(), 400);
  }, 4000);
}