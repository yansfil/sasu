// Inline SVG sprite generation (R19, D-11). Pure string-building - no DOM
// access at module scope or call time, so this module loads safely under
// AC1's plain-Node dynamic-import check. Every function returns markup a
// caller assigns via `el.innerHTML`.
//
// R19 requires species to be genuinely shape-distinguishable, not palette
// swaps of one silhouette. Each spec below composes a distinct base shape
// plus 2-4 distinct feature shapes (ears/tails/wings/shell/horn/...), so no
// two species share the same silhouette even where they share a type color.
import { TYPE_NAMES } from "../data/types.js";

const TYPE_COLOR_VAR = {
  normal: "var(--type-normal)",
  fire: "var(--type-fire)",
  water: "var(--type-water)",
  grass: "var(--type-grass)",
  electric: "var(--type-electric)",
  rock: "var(--type-rock)",
  flying: "var(--type-flying)",
};

export function typeColor(type) {
  return TYPE_COLOR_VAR[type] || "var(--type-normal)";
}

function svg(children, { size = 100 } = {}) {
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">${children}</svg>`;
}

function eyes(cx, cy, spread = 8, r = 3) {
  return `<circle cx="${cx - spread}" cy="${cy}" r="${r}" fill="#20222c"/><circle cx="${cx + spread}" cy="${cy}" r="${r}" fill="#20222c"/>`;
}

const SPECIES_SVG = {
  pikachu: c => svg(`
    <ellipse cx="50" cy="58" rx="30" ry="26" fill="${c}"/>
    <polygon points="26,20 34,44 18,42" fill="${c}"/>
    <polygon points="74,20 66,44 82,42" fill="${c}"/>
    <circle cx="30" cy="60" r="6" fill="#ff6b6b"/>
    <circle cx="70" cy="60" r="6" fill="#ff6b6b"/>
    <polygon points="78,66 96,60 88,74 98,78 80,80" fill="${c}"/>
    ${eyes(50, 52)}
  `),
  raichu: c => svg(`
    <ellipse cx="50" cy="56" rx="34" ry="30" fill="${c}"/>
    <path d="M22,26 Q18,10 34,20 Q30,34 22,26 Z" fill="${c}"/>
    <path d="M78,26 Q82,10 66,20 Q70,34 78,26 Z" fill="${c}"/>
    <circle cx="30" cy="58" r="7" fill="#ff6b6b"/>
    <circle cx="70" cy="58" r="7" fill="#ff6b6b"/>
    <polygon points="76,64 98,54 92,72 100,78 78,82 82,70" fill="${c}"/>
    ${eyes(50, 50, 9)}
  `),
  squirtle: c => svg(`
    <circle cx="50" cy="60" r="28" fill="${c}"/>
    <path d="M26,68 A24,18 0 0 0 74,68 Z" fill="#e8c37a"/>
    <path d="M50,26 A24,10 0 0 1 50,46 Z" fill="#e8c37a"/>
    <path d="M78,64 Q92,58 90,74 Q80,76 78,64 Z" fill="${c}"/>
    ${eyes(50, 54)}
  `),
  wartortle: c => svg(`
    <circle cx="50" cy="58" r="32" fill="${c}"/>
    <path d="M20,66 A30,22 0 0 0 80,66 Z" fill="#e8c37a"/>
    <path d="M28,66 L72,66" stroke="#c9a45c" stroke-width="2"/>
    <polygon points="16,30 26,42 12,44" fill="${c}"/>
    <polygon points="84,30 74,42 88,44" fill="${c}"/>
    <path d="M80,60 Q100,48 96,72 Q84,78 80,60 Z" fill="${c}"/>
    ${eyes(50, 52, 9)}
  `),
  bulbasaur: c => svg(`
    <ellipse cx="50" cy="66" rx="30" ry="20" fill="${c}"/>
    <circle cx="50" cy="42" r="18" fill="#3f8f56"/>
    <circle cx="42" cy="38" r="3" fill="#2c6b3f"/>
    <circle cx="58" cy="44" r="3" fill="#2c6b3f"/>
    ${eyes(50, 68)}
  `),
  ivysaur: c => svg(`
    <ellipse cx="50" cy="66" rx="34" ry="22" fill="${c}"/>
    <circle cx="50" cy="38" r="22" fill="#3f8f56"/>
    <polygon points="50,14 42,28 58,28" fill="#5cae72"/>
    <circle cx="40" cy="34" r="3" fill="#2c6b3f"/>
    <circle cx="60" cy="40" r="3" fill="#2c6b3f"/>
    ${eyes(50, 70, 9)}
  `),
  charmander: c => svg(`
    <ellipse cx="48" cy="60" rx="26" ry="24" fill="${c}"/>
    <polygon points="66,70 90,56 82,80 96,86 70,88" fill="#ffcc66"/>
    <polygon points="30,26 24,42 40,38" fill="${c}"/>
    <polygon points="60,24 68,38 52,36" fill="${c}"/>
    ${eyes(46, 54)}
  `),
  charmeleon: c => svg(`
    <ellipse cx="48" cy="58" rx="30" ry="28" fill="${c}"/>
    <polygon points="68,68 98,50 88,78 102,86 72,90" fill="#ffcc66"/>
    <polygon points="24,22 16,42 36,36" fill="${c}"/>
    <polygon points="24,44 14,58 34,52" fill="${c}"/>
    ${eyes(46, 52, 9)}
  `),
  jigglypuff: c => svg(`
    <circle cx="50" cy="56" r="34" fill="${c}"/>
    <path d="M32,26 Q22,10 40,18 Q42,28 32,26 Z" fill="${c}"/>
    <ellipse cx="34" cy="54" rx="14" ry="7" fill="#fff" opacity="0.5"/>
    ${eyes(50, 50, 10)}
  `),
  wigglytuff: c => svg(`
    <circle cx="50" cy="54" r="38" fill="${c}"/>
    <path d="M30,20 Q16,4 38,12 Q42,24 30,20 Z" fill="${c}"/>
    <path d="M70,20 Q84,4 62,12 Q58,24 70,20 Z" fill="${c}"/>
    <ellipse cx="34" cy="52" rx="16" ry="8" fill="#fff" opacity="0.5"/>
    ${eyes(50, 48, 11)}
  `),
  pidgey: c => svg(`
    <ellipse cx="50" cy="58" rx="26" ry="22" fill="${c}"/>
    <polygon points="20,50 4,40 22,66" fill="${c}"/>
    <polygon points="80,50 96,40 78,66" fill="${c}"/>
    <polygon points="50,36 42,20 58,20" fill="${c}"/>
    <polygon points="46,58 34,58 46,50" fill="#e8b04c"/>
    ${eyes(52, 52)}
  `),
  pidgeotto: c => svg(`
    <ellipse cx="50" cy="56" rx="30" ry="26" fill="${c}"/>
    <polygon points="16,46 -4,32 20,64" fill="${c}"/>
    <polygon points="84,46 104,32 80,64" fill="${c}"/>
    <path d="M50,30 Q40,10 60,10 Q56,24 50,30 Z" fill="${c}"/>
    <polygon points="44,56 30,56 44,46" fill="#e8b04c"/>
    ${eyes(52, 50, 9)}
  `),
  geodude: c => svg(`
    <polygon points="50,14 82,38 70,84 30,84 18,38" fill="${c}"/>
    <line x1="34" y1="42" x2="46" y2="56" stroke="#7a6a4a" stroke-width="2"/>
    <line x1="60" y1="36" x2="52" y2="58" stroke="#7a6a4a" stroke-width="2"/>
    <circle cx="24" cy="58" r="6" fill="${c}"/>
    <circle cx="76" cy="58" r="6" fill="${c}"/>
    ${eyes(50, 56)}
  `),
  magnemite: c => svg(`
    <circle cx="50" cy="54" r="26" fill="#c7cdd6"/>
    <rect x="14" y="20" width="14" height="30" rx="4" fill="${c}"/>
    <rect x="72" y="20" width="14" height="30" rx="4" fill="${c}"/>
    <circle cx="21" cy="18" r="5" fill="#8a8f99"/>
    <circle cx="79" cy="18" r="5" fill="#8a8f99"/>
    ${eyes(50, 54)}
  `),
  sandshrew: c => svg(`
    <ellipse cx="50" cy="62" rx="28" ry="22" fill="${c}"/>
    <path d="M26,50 Q50,38 74,50" stroke="#8a6a3a" stroke-width="4" fill="none"/>
    <path d="M28,62 Q50,50 72,62" stroke="#8a6a3a" stroke-width="4" fill="none"/>
    <polygon points="16,64 6,70 16,76" fill="${c}"/>
    <polygon points="84,64 94,70 84,76" fill="${c}"/>
    ${eyes(50, 56)}
  `),
  paras: c => svg(`
    <ellipse cx="50" cy="68" rx="24" ry="16" fill="${c}"/>
    <circle cx="34" cy="42" r="18" fill="#d1495b"/>
    <circle cx="66" cy="42" r="18" fill="#d1495b"/>
    <circle cx="34" cy="38" r="3" fill="#fff"/>
    <circle cx="66" cy="38" r="3" fill="#fff"/>
    ${eyes(50, 70)}
  `),
  vulpix: c => svg(`
    <ellipse cx="46" cy="58" rx="24" ry="22" fill="${c}"/>
    <polygon points="24,22 30,40 16,38" fill="${c}"/>
    <polygon points="56,20 62,38 48,36" fill="${c}"/>
    <path d="M64,64 Q90,54 84,72 Q78,60 70,68" fill="${c}"/>
    <path d="M66,72 Q94,68 84,86 Q76,74 68,80" fill="${c}"/>
    <path d="M60,78 Q84,84 68,96 Q64,84 58,86" fill="${c}"/>
    ${eyes(46, 54)}
  `),
  shellder: c => svg(`
    <polygon points="50,10 84,60 50,58 16,60" fill="${c}"/>
    <polygon points="50,90 84,60 50,58 16,60" fill="${c}" opacity="0.8"/>
    <ellipse cx="50" cy="60" rx="10" ry="6" fill="#ff9db0"/>
    ${eyes(50, 58, 0)}
  `),
  moltres: c => svg(`
    <ellipse cx="50" cy="56" rx="26" ry="24" fill="${c}"/>
    <polygon points="10,40 -10,20 24,32 20,54" fill="#ffb04c"/>
    <polygon points="90,40 110,20 76,32 80,54" fill="#ffb04c"/>
    <polygon points="50,10 38,28 62,28" fill="#ffb04c"/>
    <path d="M60,70 Q86,66 98,90 Q76,88 68,78" fill="#ffb04c"/>
    ${eyes(50, 52)}
  `),
  mew: c => svg(`
    <circle cx="50" cy="58" r="24" fill="${c}"/>
    <circle cx="34" cy="38" r="8" fill="${c}"/>
    <circle cx="66" cy="38" r="8" fill="${c}"/>
    <path d="M72,66 Q98,58 92,86 Q80,84 78,70" fill="${c}"/>
    ${eyes(50, 56, 9, 4)}
  `),
};

// Each character gets both a distinct body silhouette AND a distinct primary
// color (a same-shape, color-only-swap sprite set is exactly what R19 rules
// out for species; the same bar applies here - a shared torso rect in one
// shared color, varying only the hat, was that failure mode).
const CHARACTER_SVG = {
  jiwoo: c => svg(`
    <circle cx="50" cy="42" r="20" fill="#f2c9a0"/>
    <polygon points="26,32 74,32 50,10" fill="#e0435e"/>
    <rect x="34" y="60" width="32" height="34" rx="8" fill="${c}"/>
    ${eyes(50, 44)}
  `),
  iseul: c => svg(`
    <circle cx="50" cy="42" r="20" fill="#f2c9a0"/>
    <polygon points="28,30 18,52 34,40" fill="#3b3b46"/>
    <polygon points="72,30 82,52 66,40" fill="#3b3b46"/>
    <polygon points="30,60 70,60 78,94 22,94" fill="${c}"/>
    ${eyes(50, 44)}
  `),
  woong: c => svg(`
    <circle cx="50" cy="44" r="22" fill="#f2c9a0"/>
    <rect x="28" y="40" width="44" height="8" rx="4" fill="#3b3b46"/>
    <circle cx="40" cy="44" r="7" fill="none" stroke="#3b3b46" stroke-width="2"/>
    <circle cx="60" cy="44" r="7" fill="none" stroke="#3b3b46" stroke-width="2"/>
    <ellipse cx="50" cy="78" rx="26" ry="20" fill="${c}"/>
  `),
  green: c => svg(`
    <circle cx="50" cy="44" r="18" fill="#f2c9a0"/>
    <polygon points="24,30 34,10 40,28 50,8 60,28 66,10 76,30" fill="#c0392b"/>
    <polygon points="40,62 60,62 70,96 30,96" fill="${c}"/>
    ${eyes(50, 46)}
  `),
  mindeulle: c => svg(`
    <circle cx="50" cy="42" r="20" fill="#f2c9a0"/>
    <polygon points="42,20 50,10 58,20 50,26" fill="#e0435e"/>
    <rect x="36" y="60" width="28" height="30" rx="12" fill="${c}"/>
    <rect x="62" y="64" width="18" height="22" rx="4" fill="#7a5230"/>
    ${eyes(50, 44)}
  `),
};

const CHARACTER_COLORS = {
  jiwoo: "#e0435e",
  iseul: "#3d7dca",
  woong: "#4a9e5c",
  green: "#d64545",
  mindeulle: "#e08bc0",
};

const TILE_SVG = {
  ".": () => `<rect width="100%" height="100%" fill="#2a2f42"/>`,
  "G": () => `<rect width="100%" height="100%" fill="#2a2f42"/><rect width="100%" height="100%" fill="#3f8f56" opacity="0.75"/><path d="M6,26 L10,14 L14,26 M18,28 L22,16 L26,28" stroke="#2c6b3f" stroke-width="2" fill="none"/>`,
  "#": () => `<rect width="100%" height="100%" fill="#4a4f66"/>`,
  "~": () => `<rect width="100%" height="100%" fill="#2f5f8f"/>`,
  "^": () => `<rect width="100%" height="100%" fill="#2a2f42"/><polygon points="4,28 16,8 28,28" fill="#7a7462"/>`,
  "D": () => `<rect width="100%" height="100%" fill="#2a2f42"/><rect x="8" y="4" width="16" height="24" rx="2" fill="#8a5a2c"/>`,
  "I": () => `<rect width="100%" height="100%" fill="#2a2f42"/><rect x="8" y="12" width="16" height="14" rx="2" fill="#e0435e"/>`,
  "S": () => `<rect width="100%" height="100%" fill="#2a2f42"/><rect x="14" y="6" width="4" height="20" fill="#8a5a2c"/><rect x="6" y="8" width="20" height="10" fill="#e8c37a"/>`,
  "H": () => `<rect width="100%" height="100%" fill="#2a2f42"/><rect x="12" y="6" width="8" height="20" fill="#ff6b6b"/><rect x="6" y="12" width="20" height="8" fill="#ff6b6b"/>`,
};

export function renderSpeciesSprite(species) {
  const build = SPECIES_SVG[species.id];
  if (!build) throw new Error(`no sprite for species ${species.id}`);
  return build(typeColor(species.type));
}

export function renderCharacterSprite(character) {
  const build = CHARACTER_SVG[character.id];
  if (!build) throw new Error(`no sprite for character ${character.id}`);
  return build(CHARACTER_COLORS[character.id] || "#5b7fd6");
}

export function renderTileSprite(tileChar) {
  const build = TILE_SVG[tileChar];
  if (!build) return TILE_SVG["."]();
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" role="presentation" aria-hidden="true" width="100%" height="100%">${build()}</svg>`;
}

export function typeBadgeHtml(type) {
  return `<span class="type-badge" style="background:${typeColor(type)}">${TYPE_NAMES[type]}</span>`;
}
