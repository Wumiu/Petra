export function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}
