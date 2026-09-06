'use client';

import { Menu } from '@base-ui/react/menu';

/**
 * Global scope selector (§20.1): LIVE · PAPER:<book> · REPLAY:<run>. Switching scope never
 * changes live mode or arms anything; it only changes what the screens show. Books and runs are
 * populated once strategies and replay exist; today it lists the scopes that can exist.
 */
export function ScopeSelector({ current }: { current: string }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="btn" aria-label="Select scope">
        SCOPE: {current} ▾
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6}>
          <Menu.Popup className="scope-popup">
            <Menu.Item className="scope-item">LIVE</Menu.Item>
            <Menu.Item className="scope-item" disabled>
              PAPER: no books yet
            </Menu.Item>
            <Menu.Item className="scope-item" disabled>
              REPLAY: no runs yet
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
