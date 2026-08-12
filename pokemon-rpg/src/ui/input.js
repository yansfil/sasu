// Keyboard input mapping (R20): arrows/WASD to move, Z/Enter to confirm,
// X/Esc to cancel or open the menu. `actionForKey` is a pure function (no
// DOM at module scope); `bindKeyboard` takes its event target as a
// parameter rather than reaching for a global, so nothing here breaks
// AC1's plain-Node dynamic-import load.
const KEY_ACTIONS = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", a: "left", s: "down", d: "right",
  W: "up", A: "left", S: "down", D: "right",
  z: "confirm", Z: "confirm", Enter: "confirm",
  x: "cancel", X: "cancel", Escape: "cancel",
};

export const DIRECTION_ACTIONS = new Set(["up", "down", "left", "right"]);

export function actionForKey(key) {
  return KEY_ACTIONS[key] || null;
}

/** @returns {() => void} an unsubscribe function. */
export function bindKeyboard(target, onAction) {
  function handleKeydown(event) {
    const action = actionForKey(event.key);
    if (!action) return;
    event.preventDefault();
    onAction(action);
  }
  target.addEventListener("keydown", handleKeydown);
  return () => target.removeEventListener("keydown", handleKeydown);
}
