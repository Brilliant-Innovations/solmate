import { redirect } from 'next/navigation';

/** The Asset Workspace is per asset; the index is the scanner (§20.4, §20.5). */
export default function AssetsIndex() {
  redirect('/scanner');
}
