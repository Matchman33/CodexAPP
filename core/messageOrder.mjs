// Canonical pages own item order; live-only entries stay before their next known anchor.
export function mergeMessageEvents(canonical, overlay) {
  const saved = [...new Map(canonical.map(event => [event.id, event])).values()];
  const ids = new Set(saved.map(event => event.id));
  const live = [...new Map(overlay.map(event => [event.id, event])).values()];
  const before = new Map(), latest = new Map(), tail = [];
  let next = null;
  for (let index = live.length - 1; index >= 0; index--) {
    const event = live[index];
    if (ids.has(event.id)) { next = event.id; latest.set(event.id, event); }
    else if (next === null) tail.push(event);
    else {
      if (!before.has(next)) before.set(next, []);
      before.get(next).push(event);
    }
  }
  const result = [];
  for (const event of saved) {
    result.push(...(before.get(event.id) || []).reverse(), latest.get(event.id) || event);
  }
  return result.concat(tail.reverse());
}
