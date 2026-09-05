import { render } from '@testing-library/react';

import SolAgentTraderWalletUi from './wallet-ui';

describe('SolAgentTraderWalletUi', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<SolAgentTraderWalletUi />);
    expect(baseElement).toBeTruthy();
  });
});
