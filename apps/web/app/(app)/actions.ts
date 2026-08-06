'use server';

import { redirect } from 'next/navigation';
import { signOut } from '../../auth';

/**
 * Sign out, then land on the login page.
 *
 * `redirect: false` on `signOut` and an explicit `redirect()` afterwards, rather
 * than letting Auth.js do the navigation. Auth.js's own redirect happens inside
 * its call, which puts the `NEXT_REDIRECT` throw somewhere a future try/catch
 * could catch by accident; keeping it as the last statement of this function
 * makes that structurally impossible.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirect: false });
  redirect('/login');
}
