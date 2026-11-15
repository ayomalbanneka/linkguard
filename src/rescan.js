'use strict';

// Runs every Monday (EventBridge Scheduler): re-check every site on the watch list.
const { queryAll, startScan, WATCH_LIMIT } = require('./scans');

exports.handler = async () => {
  const watched = (await queryAll('WATCHLIST')).slice(0, WATCH_LIMIT);
  let started = 0;
  for (const item of watched) {
    try {
      await startScan(item.url, { scheduled: true });
      started += 1;
    } catch (err) {
      console.error('rescan failed', item.url, err);
    }
  }
  return { watched: watched.length, started };
};
