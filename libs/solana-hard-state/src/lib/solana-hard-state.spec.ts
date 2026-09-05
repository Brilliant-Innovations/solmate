import { solanaHardState } from './solana-hard-state.js';

describe('solanaHardState', () => {
  it('should work', () => {
    expect(solanaHardState()).toEqual('solana-hard-state');
  });
});
