export function normalizeTitle(title) {
  if (typeof title !== "string") {
    throw new TypeError("title must be a string");
  }

  const normalized = title.trim();
  if (normalized.length === 0) {
    throw new Error("title is required");
  }

  return normalized;
}

export function addItem(items, title) {
  const normalizedTitle = normalizeTitle(title);
  const nextId = items.reduce((largestId, item) => Math.max(largestId, item.id), 0) + 1;

  return [...items, { id: nextId, title: normalizedTitle, done: false }];
}

export function toggleItem(items, id) {
  return items.map((item) =>
    item.id === id ? { ...item, done: !item.done } : item,
  );
}

export function removeItem(items, id) {
  return items.filter((item) => item.id !== id);
}

export function snapshot(items) {
  return items.map((item) => ({ ...item }));
}

export function summary(items) {
  return items.length === 1 ? "1 item" : `${items.length} items`;
}
