export interface Palette {
  id: string;
  name: string;
  hint: string;
  swatch: string;
}

/**
 * Accent palettes. Each id maps to a block in styles.css that redefines
 * `--accent` and `--tint-rgb`, so every highlighted element follows along.
 */
export const PALETTES: Palette[] = [
  { id: "warm", name: "Тёплая", hint: "янтарь", swatch: "#f4a261" },
  { id: "ice", name: "Ледяная", hint: "голубой", swatch: "#6cb6ff" },
  { id: "mint", name: "Мятная", hint: "зелёный", swatch: "#63dfb4" },
  { id: "violet", name: "Сиреневая", hint: "фиолетовый", swatch: "#b49cff" },
  { id: "rose", name: "Розовая", hint: "алый", swatch: "#ff8fa3" },
  { id: "mono", name: "Графит", hint: "нейтральный", swatch: "#cfc8c2" },
];

export const DEFAULT_PALETTE = PALETTES[0].id;

export function paletteOf(id: string | null | undefined): Palette {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0];
}

export function applyPalette(id: string | null | undefined) {
  document.documentElement.dataset.palette = paletteOf(id).id;
}