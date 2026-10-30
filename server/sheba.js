// ISO 13616 mod-97 check for Iranian IBAN (IR + 24 digits).
export function isValidSheba(input) {
  const s = String(input || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^IR\d{24}$/.test(s)) return false;
  const rearranged = s.slice(4) + '1827' + s.slice(2, 4); // I=18, R=27
  return BigInt(rearranged) % 97n === 1n;
}

export function shebaBankCode(input) {
  const s = String(input || '').replace(/[\s-]/g, '').toUpperCase();
  if (s.startsWith('IR') && s.length >= 7) {
    return s.slice(4, 7);
  }
  return '';
}

export const IRANIAN_BANKS = Object.freeze({
  '010': 'بانک مرکزی جمهوری اسلامی ایران',
  '011': 'بانک صنعت و معدن',
  '012': 'بانک ملت',
  '013': 'بانک رفاه کارگران',
  '014': 'بانک مسکن',
  '015': 'بانک سپه',
  '016': 'بانک کشاورزی',
  '017': 'بانک ملی ایران',
  '018': 'بانک تجارت',
  '019': 'بانک صادرات ایران',
  '020': 'بانک توسعه صادرات ایران',
  '021': 'پست بانک ایران',
  '022': 'بانک توسعه تعاون',
  '051': 'موسسه اعتباری غیربانکی ملل',
  '053': 'بانک کارآفرین',
  '054': 'بانک پارسیان',
  '055': 'بانک اقتصاد نوین',
  '056': 'بانک سامان',
  '057': 'بانک پاسارگاد',
  '058': 'بانک سرمایه',
  '059': 'بانک سینا',
  '060': 'بانک قرض‌الحسنه مهر ایران',
  '061': 'بانک شهر',
  '062': 'بانک آینده',
  '064': 'بانک گردشگری',
  '065': 'بانک حکمت ایرانیان',
  '066': 'بانک دی',
  '069': 'بانک ایران زمین',
  '070': 'بانک قرض‌الحسنه رسالت',
  '073': 'موسسه اعتباری کوثر',
  '075': 'موسسه اعتباری ملل',
  '078': 'بانک خاورمیانه',
  '080': 'موسسه اعتباری نور'
});

export function getShebaBankName(sheba) {
  const code = shebaBankCode(sheba);
  return IRANIAN_BANKS[code] || 'بانک عضو شبکه شتاب';
}
