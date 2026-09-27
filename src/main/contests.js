'use strict';
const { modeGroup } = require('./bands');

// rst: prompt for RST; sentSerial/rcvdSerial: numbered exchange;
// sentLabel/rcvdLabel: free-text exchange parts; dupe: 'band' or 'band-group'
const CONTESTS = [
  { id: 'CQ-WW-SSB', name: 'CQ WW DX SSB', rst: true, sentSerial: false, rcvdSerial: false, sentLabel: 'My CQ zone', rcvdLabel: 'CQ zone', dupe: 'band' },
  { id: 'CQ-WW-CW', name: 'CQ WW DX CW', rst: true, sentSerial: false, rcvdSerial: false, sentLabel: 'My CQ zone', rcvdLabel: 'CQ zone', dupe: 'band' },
  { id: 'CQ-WPX-SSB', name: 'CQ WPX SSB', rst: true, sentSerial: true, rcvdSerial: true, dupe: 'band' },
  { id: 'CQ-WPX-CW', name: 'CQ WPX CW', rst: true, sentSerial: true, rcvdSerial: true, dupe: 'band' },
  { id: 'ARRL-FIELD-DAY', name: 'ARRL Field Day', rst: false, sentSerial: false, rcvdSerial: false, sentLabel: 'My class + section (e.g. 3A ORG)', rcvdLabel: 'Class + section', dupe: 'band-group' },
  { id: 'NAQP-CW', name: 'North American QSO Party CW', rst: false, sentSerial: false, rcvdSerial: false, sentLabel: 'My name + state/province', rcvdLabel: 'Name + state/province', dupe: 'band' },
  { id: 'NAQP-SSB', name: 'North American QSO Party SSB', rst: false, sentSerial: false, rcvdSerial: false, sentLabel: 'My name + state/province', rcvdLabel: 'Name + state/province', dupe: 'band' },
  { id: 'CUSTOM', name: 'Other (RST + serial)', custom: true, rst: true, sentSerial: true, rcvdSerial: true, rcvdLabel: 'Extra exchange (optional)', dupe: 'band' },
];

function contestById(id) {
  return CONTESTS.find((c) => c.id === id) || CONTESTS[0];
}

function dupeMatcher(contestAdifId, call, band, mode, rule) {
  const grp = modeGroup(mode);
  return (r) => r.CONTEST_ID === contestAdifId && r.CALL === call && r.BAND === band && (rule !== 'band-group' || modeGroup(r.MODE) === grp);
}

module.exports = { CONTESTS, contestById, dupeMatcher };
