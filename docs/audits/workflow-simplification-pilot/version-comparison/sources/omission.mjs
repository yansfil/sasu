export function normalizeTitle(value) {
  const title = String(value).trim();
  if (!title) throw new Error("title is required");
  return title;
}

export function addItem(items, value) {
  const title = normalizeTitle(value);
  const id = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  return [...items, { id, title, done: false }];
}

export function toggleItem(items, id) {
  return items.map((item) => item.id === id ? { ...item, done: !item.done } : item);
}

export function removeItem(items, id) {
  return items.filter((item) => item.id !== id);
}

export function snapshot(items) {
  return items.map((item) => ({ ...item }));
}

export function summary(items) {
  return `${items.length} items`;
}
