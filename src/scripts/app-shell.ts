const root = document.documentElement;
const body = document.body;
const FAVORITES_STORAGE_KEY = "guitare-songbook:favorites:v1";
const songCollator = new Intl.Collator("zh-CN-u-co-pinyin", {
  numeric: true,
  sensitivity: "base"
});

function loadFavorites() {
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "[]");
    return new Set<string>(
      Array.isArray(stored)
        ? stored.filter((value): value is string => typeof value === "string")
        : []
    );
  } catch {
    return new Set<string>();
  }
}

const favorites = loadFavorites();

function saveFavorites() {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
}

function updateFavoriteButtons() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-favorite-toggle]")
    .forEach((button) => {
      const slug = button.dataset.favoriteToggle ?? "";
      const isFavorite = favorites.has(slug);
      const title = button.getAttribute("aria-label")?.match(/《(.+)》/)?.[1] ?? "这首歌";
      button.setAttribute("aria-pressed", String(isFavorite));
      button.setAttribute(
        "aria-label",
        isFavorite ? `取消《${title}》的星标` : `为《${title}》加星`
      );
      button.title = isFavorite ? "取消星标" : "加星";
      const icon = button.querySelector<HTMLElement>("[aria-hidden='true']");
      if (icon) icon.textContent = isFavorite ? "★" : "☆";
    });
}

function sortSongContainers() {
  document.querySelectorAll<HTMLElement>("[data-song-list], [data-song-cards]").forEach(
    (container) => {
      const items = [...container.querySelectorAll<HTMLElement>(":scope > [data-song-item]")];
      items
        .sort((a, b) => {
          const favoriteDifference =
            Number(favorites.has(b.dataset.songSlug ?? "")) -
            Number(favorites.has(a.dataset.songSlug ?? ""));
          if (favoriteDifference !== 0) return favoriteDifference;
          return songCollator.compare(a.dataset.sortKey ?? "", b.dataset.sortKey ?? "");
        })
        .forEach((item) => container.append(item));
    }
  );
}

function updateFavorites() {
  updateFavoriteButtons();
  sortSongContainers();
}

document.querySelectorAll<HTMLButtonElement>("[data-favorite-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const slug = button.dataset.favoriteToggle;
    if (!slug) return;
    if (favorites.has(slug)) favorites.delete(slug);
    else favorites.add(slug);
    saveFavorites();
    updateFavorites();
  });
});

updateFavorites();

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

