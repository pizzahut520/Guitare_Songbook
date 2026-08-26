import { formatHarmony, keyAtTranspose } from "../lib/music";

const sheet = document.querySelector<HTMLElement>("[data-song-sheet]");

if (sheet) {
  const songSheet = sheet;
  const degreeKey = songSheet.dataset.degreeKey ?? "C";
  const chordMode = document.querySelector<HTMLSelectElement>("[data-chord-mode]");
  const transposeValue = document.querySelector<HTMLElement>("[data-transpose-value]");
  const activeKey = document.querySelector<HTMLElement>("[data-active-key]");
  const degreeNodes = songSheet.querySelectorAll<HTMLElement>("[data-degree]");
  let transpose = Number(localStorage.getItem("songbook-transpose") ?? 0);
  let fontScale = Number(localStorage.getItem("songbook-font-scale") ?? 1);
  let mode = localStorage.getItem("songbook-chord-mode") ?? "degree";

  degreeNodes.forEach((node) => {
    node.dataset.originalDegree = node.dataset.degree ?? node.textContent ?? "";
  });

  function renderHarmony() {
    const showChordNames = mode === "chord";
    degreeNodes.forEach((node) => {
      const degree = node.dataset.originalDegree ?? "";
      node.textContent = formatHarmony(
        degree,
        degreeKey,
        showChordNames ? "chord" : "degree",
        transpose
      );
    });

    if (transposeValue) {
      const sign = transpose > 0 ? "+" : "";
      transposeValue.textContent = `移调 ${sign}${transpose}`;
    }
    if (activeKey) {
      activeKey.textContent = showChordNames
        ? keyAtTranspose(degreeKey, transpose)
        : degreeKey;
    }
    if (chordMode) chordMode.value = mode;
  }

  function renderFontScale() {
    fontScale = Math.max(0.82, Math.min(1.42, fontScale));
    songSheet.style.setProperty("--user-font-scale", String(fontScale));
    localStorage.setItem("songbook-font-scale", String(fontScale));
  }

  chordMode?.addEventListener("change", () => {
    mode = chordMode.value;
    localStorage.setItem("songbook-chord-mode", mode);
    renderHarmony();
  });

  document.querySelector("[data-transpose-down]")?.addEventListener("click", () => {
    transpose = Math.max(-6, transpose - 1);
    localStorage.setItem("songbook-transpose", String(transpose));
    renderHarmony();
  });

  document.querySelector("[data-transpose-up]")?.addEventListener("click", () => {
    transpose = Math.min(6, transpose + 1);
    localStorage.setItem("songbook-transpose", String(transpose));
    renderHarmony();
  });

  document.querySelector("[data-font-decrease]")?.addEventListener("click", () => {
    fontScale -= 0.08;
    renderFontScale();
  });

  document.querySelector("[data-font-increase]")?.addEventListener("click", () => {
    fontScale += 0.08;
    renderFontScale();
  });

  const themes = ["paper", "light", "dark"];
  document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme ?? "paper";
    const next = themes[(themes.indexOf(current) + 1) % themes.length];
    document.documentElement.dataset.theme = next;
    localStorage.setItem("songbook-theme", next);
  });

  document.querySelector("[data-fullscreen]")?.addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  });

  document.querySelector("[data-print]")?.addEventListener("click", () => {
    window.print();
  });

  let wakeLock: WakeLockSentinel | null = null;
  const wakeButton = document.querySelector<HTMLButtonElement>("[data-wake-lock]");

  async function toggleWakeLock() {
    try {
      if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      } else if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
          wakeButton?.setAttribute("aria-pressed", "false");
        });
      }
      wakeButton?.setAttribute("aria-pressed", String(Boolean(wakeLock)));
      if (wakeButton) wakeButton.textContent = wakeLock ? "已常亮" : "常亮";
    } catch {
      if (wakeButton) wakeButton.textContent = "常亮不可用";
    }
  }

  wakeButton?.addEventListener("click", toggleWakeLock);
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && wakeButton?.getAttribute("aria-pressed") === "true" && !wakeLock) {
      await toggleWakeLock();
    }
  });

  renderHarmony();
  renderFontScale();
}
