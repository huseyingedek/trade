export const decimalsOf = (step) => {
  const [mant, exp] = String(step).toLowerCase().split('e')
  const mantDec = mant.includes('.') ? mant.split('.')[1].length : 0
  return Math.max(0, mantDec - (exp ? +exp : 0))
}
/** step katına yuvarla */
export const roundTo = (v, step) => +(Math.round(v / step) * step).toFixed(decimalsOf(step))
/** step katına aşağı yuvarla */
export const floorTo = (v, step) => +(Math.floor(v / step + 1e-9) * step).toFixed(decimalsOf(step))
export const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
export const gauss = () => {
  let u = 0
  let v = 0
  while (!u) u = Math.random()
  while (!v) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
