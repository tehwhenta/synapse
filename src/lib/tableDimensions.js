export const safeRowHeight = value => /^\d{1,4}$/.test(String(value)) && Number(value)>=28 && Number(value)<=1600 ? Number(value) : null
export const safeColumnWidths = value => {
  const widths=String(value || '').split(',')
  return widths.length<=100 && widths.every(n=>/^\d{1,4}$/.test(n) && Number(n)>=0 && Number(n)<=4096) ? widths.map(Number) : null
}

