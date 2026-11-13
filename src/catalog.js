export const PLAN_DATA = [
  [500, 83.33, 3750],
  [800, 133.33, 6000],
  [1500, 250, 11250],
  [2500, 416.67, 18750],
  [5000, 833.33, 37500],
  [8000, 1333.33, 60000],
  [12000, 2000, 90000],
  [15000, 2500, 112500],
  [25000, 4166.67, 187500],
  [50000, 8333.33, 375000],
  [70000, 11666.67, 525000],
  [100000, 16666.67, 750000],
].map(([price, daily, total], i) => ({
  code: `RN${String(i + 1).padStart(2, "0")}`,
  name: `Robot ${String(i + 1).padStart(2, "0")}`,
  price: Math.round(price * 100),
  daily: Math.round(daily * 100),
  total: Math.round(total * 100),
  duration: 45,
}));
// Only institutions with a verified, renderable logo are available in the UI.
export const INSTITUTIONS = [
  ["easypaisa", "Easypaisa", "EP"],
  ["jazzcash", "JazzCash", "JC"],
  ["hbl", "Habib Bank Limited", "HBL"],
  ["mcb", "MCB Bank", "MCB"],
].map(([id, name, monogram]) => ({ id, name, monogram }));
export function payoutForDay(p, day) {
  return day === p.duration ? p.total - p.daily * (p.duration - 1) : p.daily;
}
export const DAY = 86400000;
