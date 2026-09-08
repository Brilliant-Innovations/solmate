import type { MintAddress, NormalizationPolicy, Uuid } from '@sol-agent-trader/contracts';

/**
 * Asset entity matching (blueprint P4 "asset entity matching", §6.6 `asset_ids`). Deterministic
 * over the known asset universe: a mint in the payload is an exact match; a cashtag or a bare
 * upper-case symbol of sufficient length matches when exactly one known asset carries it; a
 * symbol shared by several assets is ambiguous and matches none unless a mint disambiguates.
 * Names match as whole words, case-insensitively, when at least two words long or unique and
 * not a common word. Nothing here guesses.
 */

export interface AssetEntity {
  id: Uuid;
  mint: MintAddress;
  symbol: string;
  name: string;
}

export interface EntityMatch {
  assetId: Uuid;
  by: 'MINT' | 'CASHTAG' | 'SYMBOL' | 'NAME';
  confidence: number;
}

export class EntityIndex {
  private readonly byMint = new Map<string, AssetEntity>();
  private readonly bySymbol = new Map<string, AssetEntity[]>();
  private readonly byName = new Map<string, AssetEntity[]>();

  constructor(assets: readonly AssetEntity[]) {
    for (const a of assets) {
      this.byMint.set(a.mint, a);
      const sym = a.symbol.toUpperCase();
      this.bySymbol.set(sym, [...(this.bySymbol.get(sym) ?? []), a]);
      const name = a.name.trim().toLowerCase();
      if (name.length >= 3) this.byName.set(name, [...(this.byName.get(name) ?? []), a]);
    }
  }

  get size(): number {
    return this.byMint.size;
  }

  /** Matches from explicit mints (payload) and from text (title + summary), deduplicated per asset with the strongest reason kept. */
  match(text: string, mints: readonly string[], policy: Pick<NormalizationPolicy, 'minBareSymbolLength'>): EntityMatch[] {
    const found = new Map<Uuid, EntityMatch>();
    const keep = (m: EntityMatch) => {
      const cur = found.get(m.assetId);
      if (!cur || m.confidence > cur.confidence) found.set(m.assetId, m);
    };
    for (const mint of mints) {
      const a = this.byMint.get(mint);
      if (a) keep({ assetId: a.id, by: 'MINT', confidence: 1 });
    }
    for (const tag of text.match(/\$[A-Za-z][A-Za-z0-9]{1,15}/g) ?? []) {
      const c = this.bySymbol.get(tag.slice(1).toUpperCase());
      if (c && c.length === 1) keep({ assetId: c[0]!.id, by: 'CASHTAG', confidence: 0.9 });
    }
    for (const word of text.match(/\b[A-Z][A-Z0-9]{1,15}\b/g) ?? []) {
      if (word.length < policy.minBareSymbolLength) continue;
      const c = this.bySymbol.get(word);
      if (c && c.length === 1) keep({ assetId: c[0]!.id, by: 'SYMBOL', confidence: 0.6 });
    }
    const lower = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
    for (const [name, c] of this.byName) {
      if (c.length !== 1) continue;
      if (name.split(' ').length < 2 && name.length < 5) continue; // a short single-word name is too easily a plain word
      if (lower.includes(` ${name} `)) keep({ assetId: c[0]!.id, by: 'NAME', confidence: 0.5 });
    }
    return [...found.values()].sort((x, y) => (x.assetId < y.assetId ? -1 : 1));
  }
}
