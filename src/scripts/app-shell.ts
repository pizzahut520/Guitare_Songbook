const root = document.documentElement;
const body = document.body;

function closeNav() {
  body.classList.remove("nav-open");
}

document.querySelectorAll<HTMLElement>("[data-open-nav]").forEach((button) => {
  button.addEventListener("click", () => body.classList.add("nav-open"));
});

document.querySelectorAll<HTMLElement>("[data-close-nav]").forEach((button) => {
  button.addEventListener("click", closeNav);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeNav();
});

const searchInputs = document.querySelectorAll<HTMLInputElement>("[data-song-filter]");
const searchableItems = document.querySelectorAll<HTMLElement>("[data-search-text]");
const emptyMessage = document.querySelector<HTMLElement>("[data-empty-filter]");

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, "");
}

function filterSongs(query: string) {
  const normalizedQuery = normalize(query);
  let visible = 0;

  searchableItems.forEach((item) => {
    const matches = normalize(item.dataset.searchText ?? "").includes(normalizedQuery);
    item.hidden = !matches;
    if (matches) visible += 1;
  });

  if (emptyMessage) emptyMessage.hidden = visible !== 0;
}

searchInputs.forEach((input) => {
  input.addEventListener("input", () => filterSongs(input.value));
});

const networkState = document.querySelector<HTMLElement>("[data-network-state]");
function updateNetworkState() {
  if (!networkState) return;
  networkState.textContent = navigator.onLine ? "可离线使用" : "当前离线";
  networkState.classList.toggle("is-offline", !navigator.onLine);
}
window.addEventListener("online", updateNetworkState);
window.addEventListener("offline", updateNetworkState);
updateNetworkState();

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installPrompt: BeforeInstallPromptEvent | null = null;
const installButton = document.querySelector<HTMLButtonElement>("[data-install-app]");

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event as BeforeInstallPromptEvent;
  if (installButton) installButton.hidden = false;
});

installButton?.addEventListener("click", async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installButton.hidden = true;
});

