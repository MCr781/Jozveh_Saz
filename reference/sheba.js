// ISO 13616 mod-97 check for Iranian IBAN (IR + 24 digits).
export function isValidSheba(input) {
  const s = String(input || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^IR\d{24}$/.test(s)) return false;
  const rearranged = s.slice(4) + '1827' + s.slice(2, 4); // I=18, R=27
  return BigInt(rearranged) % 97n === 1n;
}
export function shebaBankCode(s) { return String(s).slice(4, 7); } // digits 5-7 (verify mapping table before use)
