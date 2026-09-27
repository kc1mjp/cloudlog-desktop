'use strict';

const BANDS = [
  ['2190m', 0.1357, 0.1378], ['630m', 0.472, 0.479], ['560m', 0.501, 0.504],
  ['160m', 1.8, 2.0], ['80m', 3.5, 4.0], ['60m', 5.06, 5.45], ['40m', 7.0, 7.3],
  ['30m', 10.1, 10.15], ['20m', 14.0, 14.35], ['17m', 18.068, 18.168],
  ['15m', 21.0, 21.45], ['12m', 24.89, 24.99], ['10m', 28.0, 29.7],
  ['6m', 50, 54], ['4m', 70, 71], ['2m', 144, 148], ['1.25m', 222, 225],
  ['70cm', 420, 450], ['33cm', 902, 928], ['23cm', 1240, 1300],
  ['13cm', 2300, 2450], ['9cm', 3300, 3500], ['6cm', 5650, 5925], ['3cm', 10000, 10500],
];

const BAND_NAMES = BANDS.map((b) => b[0]);

function freqToBand(mhz) {
  const f = Number(mhz);
  if (!isFinite(f)) return '';
  for (const [name, lo, hi] of BANDS) if (f >= lo && f <= hi) return name;
  return '';
}

const MODES = ['SSB', 'CW', 'FM', 'AM', 'RTTY', 'FT8', 'FT4', 'JS8', 'PSK31', 'MFSK', 'DIGITALVOICE'];

// Hamlib mode name -> ADIF mode/submode
function hamlibToAdif(hl, mhz) {
  switch ((hl || '').toUpperCase()) {
    case 'USB': return { mode: 'SSB', submode: 'USB' };
    case 'LSB': return { mode: 'SSB', submode: 'LSB' };
    case 'CW': case 'CWR': return { mode: 'CW', submode: '' };
    case 'AM': case 'AMS': case 'SAM': return { mode: 'AM', submode: '' };
    case 'FM': case 'WFM': case 'PKTFM': case 'FMN': return { mode: 'FM', submode: '' };
    case 'RTTY': case 'RTTYR': return { mode: 'RTTY', submode: '' };
    case 'PKTUSB': case 'PKTLSB': case 'DIGI': case 'DATA': return { mode: 'FT8', submode: '', digital: true };
    default: return { mode: 'SSB', submode: mhz && mhz < 10 ? 'LSB' : 'USB' };
  }
}

// ADIF mode -> hamlib mode name (for setting the radio)
function adifToHamlib(mode, mhz) {
  switch ((mode || '').toUpperCase()) {
    case 'SSB': return mhz && mhz < 10 ? 'LSB' : 'USB';
    case 'CW': return 'CW';
    case 'FM': return 'FM';
    case 'AM': return 'AM';
    case 'RTTY': return 'RTTY';
    default: return mhz && mhz < 10 ? 'PKTLSB' : 'PKTUSB';
  }
}

function modeGroup(mode) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return 'CW';
  if (['SSB', 'USB', 'LSB', 'AM', 'FM'].includes(m)) return 'PHONE';
  return 'DIGITAL';
}

function defaultRst(mode) {
  const m = (mode || '').toUpperCase();
  if (['SSB', 'AM', 'FM', 'USB', 'LSB'].includes(m)) return '59';
  if (['FT8', 'FT4', 'JS8'].includes(m)) return '-10';
  return '599';
}

function nowUtc(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return {
    date: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`,
  };
}

module.exports = { BANDS, BAND_NAMES, MODES, freqToBand, hamlibToAdif, adifToHamlib, modeGroup, defaultRst, nowUtc };
