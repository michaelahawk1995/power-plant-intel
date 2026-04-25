// Seed source_registry with the 23-CIK SEC EDGAR watchlist for slice 1.
// Idempotent: uses upsert on source_key.

import { loadDotEnv, db } from '@ppi/shared';

loadDotEnv();

const WATCHLIST: Array<{ cik: string; ticker: string; name: string }> = [
  // Power generators / IPPs
  { cik: '0001692819', ticker: 'VST', name: 'Vistra Corp' },
  { cik: '0001013871', ticker: 'NRG', name: 'NRG Energy' },
  { cik: '0001868275', ticker: 'CEG', name: 'Constellation Energy' },
  { cik: '0001622536', ticker: 'TLN', name: 'Talen Energy' },
  // Equipment / fuel cells
  { cik: '0001664703', ticker: 'BE', name: 'Bloom Energy' },
  { cik: '0001996862', ticker: 'GEV', name: 'GE Vernova' },
  // Data center REITs
  { cik: '0001101239', ticker: 'EQIX', name: 'Equinix' },
  { cik: '0001297996', ticker: 'DLR', name: 'Digital Realty' },
  // Crypto/HPC infra (data center pivot stories)
  { cik: '0001828105', ticker: 'IREN', name: 'IREN Limited' },
  { cik: '0001839341', ticker: 'CORZ', name: 'Core Scientific' },
  { cik: '0001167419', ticker: 'RIOT', name: 'Riot Platforms' },
  { cik: '0001507605', ticker: 'MARA', name: 'MARA Holdings' },
  { cik: '0001819989', ticker: 'CIFR', name: 'Cipher Mining' },
  { cik: '0001083301', ticker: 'WULF', name: 'TeraWulf' },
  { cik: '0001144879', ticker: 'APLD', name: 'Applied Digital' },
  { cik: '0001904086', ticker: 'BTDR', name: 'Bitdeer Technologies' },
  { cik: '0000827876', ticker: 'CLSK', name: 'CleanSpark' },
  { cik: '0001964333', ticker: 'HUT', name: 'Hut 8 Corp' },
  // Hyperscalers (used as confirmation only — deprioritized in extractor)
  { cik: '0000789019', ticker: 'MSFT', name: 'Microsoft' },
  { cik: '0001652044', ticker: 'GOOG', name: 'Alphabet' },
  { cik: '0001326801', ticker: 'META', name: 'Meta Platforms' },
  { cik: '0001018724', ticker: 'AMZN', name: 'Amazon' },
  { cik: '0001341439', ticker: 'ORCL', name: 'Oracle' },
];

async function main() {
  const rows = WATCHLIST.map((w) => ({
    source_key: `sec_edgar:${w.ticker.toLowerCase()}`,
    family: 'sec_edgar',
    display_name: `${w.name} (${w.ticker})`,
    endpoint_url: `https://data.sec.gov/submissions/CIK${w.cik}.json`,
    fetch_method: 'http_get',
    parse_hint: { cik: w.cik, ticker: w.ticker, forms: ['8-K', '10-Q', '10-K', 'S-1', '425', 'DEF 14A'] },
    poll_minutes: 30,
    enabled: true,
  }));

  const { error, count } = await db()
    .from('source_registry')
    .upsert(rows, { onConflict: 'source_key', count: 'exact' });

  if (error) throw error;
  console.log(`upserted ${count ?? rows.length} sources`);

  const { data } = await db()
    .from('source_registry')
    .select('source_key, display_name, enabled')
    .eq('family', 'sec_edgar')
    .order('source_key');
  console.log(`\nsec_edgar sources now in registry:`);
  for (const r of data ?? []) console.log(`  ${r.enabled ? '✓' : ' '} ${r.source_key}  ${r.display_name}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
