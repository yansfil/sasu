export function normalizeTitle(title) {
  const normalized = title.trim();

  if (normalized.length === 0) {
    throw new Error("title is required");
  }

  return normalized;
}

export function addItem(items, title) {
  const normalizedTitle = normalizeTitle(title);
  const nextId = items.reduce((highestId, item) => Math.max(highestId, item.id), 0) + 1;

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
  const count = items.length;
  return `${count} ${count === 1 ? "item" : "items"}`;
}
