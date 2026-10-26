/** Preserve saved (including temporarily absent) accounts and append newly discovered ones. */
export const completeAccountOrder = (saved: readonly string[], accounts: readonly string[]): string[] =>
  [...new Set([...saved, ...accounts])];

/** Swap visible neighbours while preserving hidden and temporarily absent account slots. */
export const moveAccountOrder = (input: {
  saved: readonly string[];
  accounts: readonly string[];
  visible: readonly string[];
  id: string;
  direction: -1 | 1;
}): string[] | undefined => {
  const index = input.visible.indexOf(input.id);
  const neighbour = input.visible[index + input.direction];
  if (index < 0 || neighbour === undefined) return undefined;
  const order = completeAccountOrder(input.saved, input.accounts);
  const from = order.indexOf(input.id);
  const to = order.indexOf(neighbour);
  if (from < 0 || to < 0) return undefined;
  [order[from], order[to]] = [order[to]!, order[from]!];
  return order;
};
