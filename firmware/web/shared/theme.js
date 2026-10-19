export function theme() {
  return (
    document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
}
export function setTheme(value) {
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem("drouter-theme", value);
  } catch {}
}
export function toggleTheme() {
  setTheme(theme() === "dark" ? "light" : "dark");
  return theme();
}
try {
  const saved = localStorage.getItem("drouter-theme");
  if (saved === "dark" || saved === "light")
    document.documentElement.dataset.theme = saved;
} catch {}
